import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetResultCachesForTests } from "../state/result-cache.js";
import { getTaskManager, resetTaskManagersForTests } from "../task/orchestrator.js";
import type { DeviceIdentity } from "../identity/device.js";
import type { Lease, ToolContext } from "../types.js";
import { createServer } from "./mcp-server.js";

interface RegisteredTool {
  handler?: (input: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
}

describe("efficiency upgrade tools", () => {
  let stateDir: string;
  let projectRoot: string;
  let session: { activeProjectId: string | null; mode: string; lease: Lease | null };
  let events: Array<Record<string, unknown>>;
  let tools: Record<string, RegisteredTool>;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-upgrade-state-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-upgrade-project-"));
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"console.log('test-ok')\"",
          typecheck: "node -e \"console.log('types-ok')\"",
        },
      }),
    );
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Upgrade fixture\n");
    session = { activeProjectId: null, mode: "observe", lease: null };
    events = [];
    const identity: DeviceIdentity = {
      version: 1,
      instanceId: "inst_upgrade-test-instance",
      displayName: "Upgrade Test",
      createdAt: 0,
      updatedAt: 0,
    };
    const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
    const ctx: ToolContext = {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      identity,
      registry,
      ledger: { append: async (event) => events.push(event) },
      store: {
        loadProjects: async () => registry,
        saveProjects: async () => undefined,
        getSession: async () => session,
        setSession: async (next) => {
          session = next as typeof session;
        },
      },
      config: {
        workspaceRoot: path.dirname(projectRoot),
        stateDir,
        maxReadBytes: 1024 * 1024,
        maxPatchBytes: 1024 * 1024,
        defaultCommandTimeoutSec: 30,
        defaultLeaseTtlMs: 60_000,
      },
    };
    resetResultCachesForTests();
    resetTaskManagersForTests();
    const server = await createServer(ctx);
    tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  });

  afterEach(async () => {
    resetResultCachesForTests();
    resetTaskManagersForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("bootstraps a compact project context and caches repeated reads", async () => {
    const first = await tools.project_bootstrap?.handler?.({ projectId: "proj", topic: "fixture" });
    const second = await tools.project_bootstrap?.handler?.({ projectId: "proj", topic: "fixture" });
    expect(first?.isError).toBeFalsy();
    expect(second?.structuredContent?.project).toMatchObject({ projectId: "proj" });
    expect(second?.structuredContent?.keyFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
    expect(events.some((event) => event.type === "tool.call.cache_hit" && event.tool === "project_bootstrap")).toBe(true);
  });

  it("rejects a mutation targeted at another instance before touching the project", async () => {
    const result = await tools.project_select?.handler?.({
      projectId: "proj",
      reason: "wrong target",
      preset: "full-write",
      targetInstanceId: "inst_a-different-instance-0000",
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("TARGET_INSTANCE_MISMATCH");
    expect(session.activeProjectId).toBeNull();
  });

  it("applies a patch and automatically verifies changed files", async () => {
    const selected = await tools.project_select?.handler?.({ projectId: "proj", reason: "upgrade test", preset: "full-write" });
    expect(selected?.isError).toBeFalsy();
    const result = await tools.change_and_verify?.handler?.({
      projectId: "proj",
      patch: "*** Begin Patch\n*** Add File: src/upgrade.ts\n+export const upgrade = true;\n*** End Patch",
    });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.verified).toBe(true);
    expect(result?.structuredContent?.changedFiles).toEqual(["src/upgrade.ts"]);
    expect(result?.structuredContent?.selectedCommands).toEqual(expect.arrayContaining([expect.objectContaining({ commandId: "npm:typecheck" })]));
    await expect(fs.readFile(path.join(projectRoot, "src/upgrade.ts"), "utf8")).resolves.toContain("upgrade = true");
  });

  it("queues one explicit goal through task_execute and preserves it in task evidence", async () => {
    const selected = await tools.project_select?.handler?.({ projectId: "proj", reason: "task execute test", preset: "full-write" });
    expect(selected?.isError).toBeFalsy();
    const queued = await tools.task_execute?.handler?.({
      goal: "Run the project's safe verification command",
      projectId: "proj",
      kind: "command",
      commandId: "npm:test",
      maxRetries: 1,
    });
    expect(queued?.isError).toBeFalsy();
    const taskId = String(queued?.structuredContent?.task && (queued.structuredContent.task as { taskId?: unknown }).taskId);
    expect(taskId).toMatch(/^task-/);
    const finished = await getTaskManager(stateDir).wait(taskId, 5_000);
    expect(finished.status).toBe("succeeded");
    expect(finished.inputSummary).toMatchObject({ goalPreview: "Run the project's safe verification command", retryLimit: 1 });
    expect(finished.result).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(events.some((event) => event.type === "task.execute.created")).toBe(true);
  });

  it("accepts a goal-only task_execute call without guessing a local command", async () => {
    const result = await tools.task_execute?.handler?.({ goal: "Improve the onboarding flow" });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.executionQueued).toBe(false);
    expect(result?.structuredContent?.executionState).toBe("awaiting-explicit-spec");
    expect(result?.structuredContent?.goalId).toMatch(/^goal-/);
    expect(events.some((event) => event.type === "task.execute.planned")).toBe(true);
  });

  it("bounds verification retries and stops when the same failure repeats", async () => {
    const selected = await tools.project_select?.handler?.({ projectId: "proj", reason: "retry test", preset: "full-write" });
    expect(selected?.isError).toBeFalsy();
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"console.log('test-ok')\"",
          typecheck: "node -e \"console.log('types-ok')\"",
          check: "node -e \"console.error('check-failed'); process.exit(1)\"",
        },
      }),
    );
    const result = await tools.change_and_verify?.handler?.({
      projectId: "proj",
      patch: "*** Begin Patch\n*** Add File: src/retry.ts\n+export const retry = true;\n*** End Patch",
      testCommandIds: ["npm:check"],
      maxRetries: 3,
    });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.verified).toBe(false);
    expect(result?.structuredContent?.sameFailureDetected).toBe(true);
    expect(result?.structuredContent?.attempts).toBe(2);
    expect(result?.structuredContent?.retryLimit).toBe(3);
  });
});
