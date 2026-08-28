import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { resetTaskManagersForTests, TaskManager } from "./orchestrator.js";

describe("TaskManager", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-task-manager-"));
    resetTaskManagersForTests();
  });
  afterEach(async () => {
    resetTaskManagersForTests();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("allows concurrent reads but keeps a project write exclusive", async () => {
    const manager = new TaskManager(stateDir, 3);
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const read = () => readsReleased;
    const first = await manager.start({ projectId: "p", kind: "command", access: "read", run: async () => read() });
    const second = await manager.start({ projectId: "p", kind: "command", access: "read", run: async () => read() });
    const write = await manager.start({ projectId: "p", kind: "command", access: "write", run: async () => "written" });

    expect((await manager.get(first.taskId)).status).toBe("running");
    expect((await manager.get(second.taskId)).status).toBe("running");
    expect((await manager.get(write.taskId)).status).toBe("queued");

    releaseReads();
    expect((await manager.wait(first.taskId)).status).toBe("succeeded");
    expect((await manager.wait(second.taskId)).status).toBe("succeeded");
    expect((await manager.wait(write.taskId)).status).toBe("succeeded");
  });

  it("enforces the global concurrency limit across projects", async () => {
    const manager = new TaskManager(stateDir, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await manager.start({ projectId: "one", kind: "shell", run: async () => gate });
    const second = await manager.start({ projectId: "two", kind: "shell", run: async () => "ok" });
    expect((await manager.get(first.taskId)).status).toBe("running");
    expect((await manager.get(second.taskId)).status).toBe("queued");
    release();
    expect((await manager.wait(second.taskId)).status).toBe("succeeded");
  });

  it("cancels queued and running tasks", async () => {
    const manager = new TaskManager(stateDir, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await manager.start({
      projectId: "p",
      kind: "command",
      run: async ({ signal }) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          gate.then(resolve);
        }),
    });
    const queued = await manager.start({ projectId: "p2", kind: "command", run: async () => "never" });
    expect((await manager.cancel(queued.taskId)).status).toBe("canceled");
    expect((await manager.get(queued.taskId)).error?.code).toBe(ErrorCode.TASK_CANCELED);
    await manager.cancel(first.taskId);
    release();
    expect((await manager.wait(first.taskId)).status).toBe("canceled");
  });

  it("marks persisted queued/running work interrupted after a restart", async () => {
    const manager = new TaskManager(stateDir, 1);
    const gate = new Promise<void>(() => undefined);
    const task = await manager.start({ projectId: "p", kind: "command", run: async () => gate });
    resetTaskManagersForTests();
    const restarted = new TaskManager(stateDir, 1);
    const loaded = await restarted.get(task.taskId);
    expect(loaded.status).toBe("failed");
    expect(loaded.error?.code).toBe(ErrorCode.TASK_INTERRUPTED);
  });

  it("cancels unfinished work when its transport session closes", async () => {
    const manager = new TaskManager(stateDir, 1);
    const gate = new Promise<void>(() => undefined);
    const task = await manager.start({ projectId: "p", sessionId: "session-1", kind: "shell", run: async ({ signal }) => new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
      gate.then(resolve);
    }) });
    expect((await manager.cancelForSession("session-1"))).toBe(1);
    expect((await manager.wait(task.taskId)).status).toBe("canceled");
  });
});
