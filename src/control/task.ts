import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

export type ComputerTaskStatus = "active" | "succeeded" | "failed" | "canceled";

export interface ComputerTaskRecord {
  taskId: string;
  instanceId: string;
  projectId: string;
  appName: string;
  goalPreview: string;
  status: ComputerTaskStatus;
  createdAt: number;
  updatedAt: number;
  maxSteps: number;
  step: number;
  lastActionId?: string;
  lastScreenshotHash?: string;
  repeatedObservationCount: number;
  outcome?: string;
  error?: string;
}

const TaskSchema = z.object({
  taskId: z.string().regex(/^ctask_[0-9a-f-]{36}$/i),
  instanceId: z.string().min(1),
  projectId: z.string().min(1),
  appName: z.string().min(1),
  goalPreview: z.string().min(1).max(2000),
  status: z.enum(["active", "succeeded", "failed", "canceled"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  maxSteps: z.number().int().min(1).max(50),
  step: z.number().int().nonnegative(),
  lastActionId: z.string().optional(),
  lastScreenshotHash: z.string().optional(),
  repeatedObservationCount: z.number().int().nonnegative(),
  outcome: z.string().max(2000).optional(),
  error: z.string().max(1000).optional(),
}) satisfies z.ZodType<ComputerTaskRecord>;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
let mutationChain: Promise<void> = Promise.resolve();

function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

function tasksDir(stateDir: string): string {
  return path.join(stateDir, "control", "tasks");
}

function assertTaskId(taskId: string): void {
  if (!/^ctask_[0-9a-f-]{36}$/i.test(taskId) || path.basename(taskId) !== taskId) {
    throw new DomainError(ErrorCode.TASK_NOT_FOUND, `Invalid Computer Use task id: ${taskId}`);
  }
}

function taskPath(stateDir: string, taskId: string): string {
  assertTaskId(taskId);
  return path.join(tasksDir(stateDir), `${taskId}.json`);
}

async function writeTask(stateDir: string, task: ComputerTaskRecord): Promise<void> {
  const dir = tasksDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const target = taskPath(stateDir, task.taskId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await fs.rename(temp, target);
  await fs.chmod(target, FILE_MODE).catch(() => undefined);
}

export async function startComputerTask(
  stateDir: string,
  input: Pick<ComputerTaskRecord, "instanceId" | "projectId" | "appName" | "goalPreview"> & { maxSteps?: number },
): Promise<ComputerTaskRecord> {
  return withMutationLock(async () => {
    const now = Date.now();
    const task: ComputerTaskRecord = {
      taskId: `ctask_${randomUUID()}`,
      instanceId: input.instanceId,
      projectId: input.projectId,
      appName: input.appName,
      goalPreview: input.goalPreview.slice(0, 2000),
      status: "active",
      createdAt: now,
      updatedAt: now,
      maxSteps: Math.min(50, Math.max(1, Math.floor(input.maxSteps ?? 12))),
      step: 0,
      repeatedObservationCount: 0,
    };
    await writeTask(stateDir, task);
    return task;
  });
}

export async function getComputerTask(stateDir: string, taskId: string): Promise<ComputerTaskRecord> {
  try {
    const parsed = TaskSchema.safeParse(JSON.parse(await fs.readFile(taskPath(stateDir, taskId), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Mapped to the stable task-not-found domain error below.
  }
  throw new DomainError(ErrorCode.TASK_NOT_FOUND, `Computer Use task not found: ${taskId}`);
}

async function patchTaskUnlocked(
  stateDir: string,
  taskId: string,
  patch: Partial<ComputerTaskRecord>,
): Promise<ComputerTaskRecord> {
  const current = await getComputerTask(stateDir, taskId);
  const next = TaskSchema.parse({ ...current, ...patch, taskId: current.taskId, updatedAt: Date.now() });
  await writeTask(stateDir, next);
  return next;
}

export async function recordComputerObservation(
  stateDir: string,
  taskId: string,
  screenshotHash: string,
): Promise<ComputerTaskRecord> {
  return withMutationLock(async () => {
    const current = await getComputerTask(stateDir, taskId);
    if (current.status !== "active") return current;
    const step = current.step + 1;
    const repeatedObservationCount =
      current.lastScreenshotHash === screenshotHash ? current.repeatedObservationCount + 1 : 0;
    const limitReached = step >= current.maxSteps;
    return patchTaskUnlocked(stateDir, taskId, {
      step,
      lastScreenshotHash: screenshotHash,
      repeatedObservationCount,
      ...(limitReached ? { status: "failed", error: "computer-task-step-limit-reached" } : {}),
    });
  });
}

export async function linkComputerTaskAction(
  stateDir: string,
  taskId: string,
  actionId: string,
): Promise<ComputerTaskRecord> {
  return withMutationLock(async () => {
    const current = await getComputerTask(stateDir, taskId);
    if (current.status !== "active") {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Computer Use task is ${current.status}: ${taskId}`);
    }
    return patchTaskUnlocked(stateDir, taskId, { lastActionId: actionId });
  });
}

export async function finishComputerTask(
  stateDir: string,
  taskId: string,
  status: Exclude<ComputerTaskStatus, "active">,
  outcome?: string,
): Promise<ComputerTaskRecord> {
  return withMutationLock(async () => {
    const current = await getComputerTask(stateDir, taskId);
    if (current.status !== "active") return current;
    return patchTaskUnlocked(stateDir, taskId, {
      status,
      outcome: outcome?.slice(0, 2000),
      ...(status === "failed" ? { error: outcome?.slice(0, 1000) ?? "computer-task-failed" } : {}),
    });
  });
}
