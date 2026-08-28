import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  finishComputerTask,
  getComputerTask,
  linkComputerTaskAction,
  recordComputerObservation,
  startComputerTask,
} from "./task.js";

describe("Computer Use task state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-computer-task-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("tracks observations, linked actions, repeated frames, and completion", async () => {
    const started = await startComputerTask(stateDir, {
      instanceId: "inst_test",
      projectId: "proj",
      appName: "TextEdit",
      goalPreview: "Write hello",
      maxSteps: 4,
    });
    await recordComputerObservation(stateDir, started.taskId, "frame-a");
    const repeated = await recordComputerObservation(stateDir, started.taskId, "frame-a");
    expect(repeated).toMatchObject({ step: 2, repeatedObservationCount: 1 });
    await linkComputerTaskAction(stateDir, started.taskId, "ctl_00000000-0000-0000-0000-000000000000");
    const done = await finishComputerTask(stateDir, started.taskId, "succeeded", "hello written");
    expect(done).toMatchObject({ status: "succeeded", outcome: "hello written" });
    await expect(getComputerTask(stateDir, started.taskId)).resolves.toMatchObject({ lastActionId: expect.stringMatching(/^ctl_/) });
  });

  it("fails closed when the observation step limit is reached", async () => {
    const started = await startComputerTask(stateDir, {
      instanceId: "inst_test",
      projectId: "proj",
      appName: "TextEdit",
      goalPreview: "bounded task",
      maxSteps: 2,
    });
    await recordComputerObservation(stateDir, started.taskId, "one");
    const limited = await recordComputerObservation(stateDir, started.taskId, "two");
    expect(limited).toMatchObject({ status: "failed", error: "computer-task-step-limit-reached" });
    const unchanged = await finishComputerTask(stateDir, started.taskId, "succeeded", "must not reopen");
    expect(unchanged).toMatchObject({ status: "failed", error: "computer-task-step-limit-reached" });
  });

  it("serializes concurrent observations without losing steps", async () => {
    const started = await startComputerTask(stateDir, {
      instanceId: "inst_test",
      projectId: "proj",
      appName: "TextEdit",
      goalPreview: "parallel observations",
      maxSteps: 10,
    });
    await Promise.all([
      recordComputerObservation(stateDir, started.taskId, "one"),
      recordComputerObservation(stateDir, started.taskId, "two"),
      recordComputerObservation(stateDir, started.taskId, "three"),
    ]);
    await expect(getComputerTask(stateDir, started.taskId)).resolves.toMatchObject({ step: 3, status: "active" });
  });
});
