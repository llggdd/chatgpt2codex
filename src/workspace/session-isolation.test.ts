import { describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { resolveActiveProject } from "./active.js";
import { requireProjectLease } from "./lease-guard.js";

function makeContext(sessionState: unknown): ToolContext {
  const registry = [
    { projectId: "office", name: "office", root: "/tmp/office", aliases: [] },
    { projectId: "home", name: "home", root: "/tmp/home", aliases: [] },
  ];
  let state = sessionState;
  return {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/chatgpt2codex-session-test",
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      // This value deliberately differs from the per-connection state below.
      getSession: async () => ({ activeProjectId: null, mode: "observe", lease: null }),
      setSession: async (next) => {
        state = next;
      },
    },
    sessionStore: {
      getSession: async () => state,
      setSession: async (next) => {
        state = next;
      },
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/chatgpt2codex-session-test",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

describe("per-connection session state", () => {
  it("uses the isolated session store for active project and lease checks", async () => {
    const expiresAt = Date.now() + 60_000;
    const ctx = makeContext({
      activeProjectId: "office",
      mode: "read",
      lease: {
        projectId: "office",
        leaseId: "lease-office",
        projectRoot: "/tmp/office",
        preset: "full-write",
        issuedAt: Date.now(),
        expiresAt,
      },
    });

    const active = await resolveActiveProject(ctx);
    expect(active?.projectId).toBe("office");
    expect(active?.root).toBe("/tmp/office");
    expect((await requireProjectLease(ctx, "office", "write")).leaseId).toBe("lease-office");
  });
});

