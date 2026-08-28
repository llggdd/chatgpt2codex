import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type TaskAccess = "read" | "write";
export type TaskKind = "command" | "shell" | "e2e";

export interface TaskError {
  code: string;
  message: string;
  details?: unknown;
}

export interface TaskMetrics {
  queueMs?: number;
  durationMs?: number;
}

export interface TaskRecord {
  taskId: string;
  projectId: string;
  kind: TaskKind;
  access: TaskAccess;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  targetInstanceId?: string;
  sessionId?: string;
  inputSummary?: Record<string, unknown>;
  progress?: unknown;
  metrics?: TaskMetrics;
  result?: unknown;
  error?: TaskError;
  cancelRequested?: boolean;
}

export interface TaskRunContext {
  signal: AbortSignal;
  report(progress: unknown): Promise<void>;
}

export interface TaskSpec {
  projectId: string;
  kind: TaskKind;
  access?: TaskAccess;
  targetInstanceId?: string;
  sessionId?: string;
  inputSummary?: Record<string, unknown>;
  run(context: TaskRunContext): Promise<unknown>;
}

export interface TaskListOptions {
  projectId?: string;
  status?: TaskStatus | TaskStatus[];
  limit?: number;
}

interface RuntimeTask {
  spec: TaskSpec;
  controller: AbortController;
}

const DEFAULT_MAX_CONCURRENT = 2;
const MAX_ALLOWED_CONCURRENT = 8;

function configuredMaxConcurrent(value?: number): number {
  const fromEnv = Number.parseInt(process.env.CHATGPT2CODEX_MAX_CONCURRENT_TASKS ?? "", 10);
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : Number.isFinite(fromEnv) ? fromEnv : DEFAULT_MAX_CONCURRENT;
  return Math.min(MAX_ALLOWED_CONCURRENT, Math.max(1, Math.floor(candidate)));
}

function taskError(err: unknown): TaskError {
  if (err instanceof DomainError) {
    return { code: err.code, message: redactText(err.message), details: redactUnknown(err.details) };
  }
  if (err && typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError") {
    return { code: ErrorCode.TASK_CANCELED, message: "Task canceled" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: ErrorCode.NOT_IMPLEMENTED, message: redactText(message) };
}

function redactText(value: string): string {
  return redact(value);
}

function redactUnknown(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactUnknown(item);
    return out;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "canceled";
}

function isTaskAccess(value: unknown): value is TaskAccess {
  return value === "read" || value === "write";
}

function isTaskKind(value: unknown): value is TaskKind {
  return value === "command" || value === "shell" || value === "e2e";
}

function parseRecord(value: unknown): TaskRecord | undefined {
  const record = asRecord(value);
  if (!record || typeof record.taskId !== "string" || typeof record.projectId !== "string") return undefined;
  if (!isTaskKind(record.kind) || !isTaskAccess(record.access) || !isTaskStatus(record.status)) return undefined;
  if (typeof record.createdAt !== "string") return undefined;
  const errorRecord = asRecord(record.error);
  const metricsRecord = asRecord(record.metrics);
  return {
    taskId: record.taskId,
    projectId: record.projectId,
    kind: record.kind,
    access: record.access,
    status: record.status,
    createdAt: record.createdAt,
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.finishedAt === "string" ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.targetInstanceId === "string" ? { targetInstanceId: record.targetInstanceId } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(asRecord(record.inputSummary) ? { inputSummary: asRecord(record.inputSummary) } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(metricsRecord
      ? {
          metrics: {
            ...(typeof metricsRecord.queueMs === "number" ? { queueMs: metricsRecord.queueMs } : {}),
            ...(typeof metricsRecord.durationMs === "number" ? { durationMs: metricsRecord.durationMs } : {}),
          },
        }
      : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(errorRecord && typeof errorRecord.code === "string" && typeof errorRecord.message === "string"
      ? { error: { code: errorRecord.code, message: errorRecord.message, details: errorRecord.details } }
      : {}),
    ...(record.cancelRequested === true ? { cancelRequested: true } : {}),
  };
}

/**
 * Small persistent in-process task scheduler. It intentionally stores task
 * metadata and results on disk, while executable closures remain in memory;
 * a process restart therefore marks unfinished work interrupted instead of
 * pretending it resumed safely.
 */
export class TaskManager {
  readonly maxConcurrent: number;
  private readonly stateDir: string;
  private readonly tasksDir: string;
  private readonly records = new Map<string, TaskRecord>();
  private readonly runtime = new Map<string, RuntimeTask>();
  private loaded = false;
  private pumping = false;
  private pumpRequested = false;

  constructor(stateDir: string, maxConcurrent?: number) {
    this.stateDir = path.resolve(stateDir);
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.maxConcurrent = configuredMaxConcurrent(maxConcurrent);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await fs.mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    const names = await fs.readdir(this.tasksDir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = parseRecord(JSON.parse(await fs.readFile(path.join(this.tasksDir, name), "utf8")));
        if (!parsed) continue;
        if (parsed.status === "queued" || parsed.status === "running") {
          parsed.status = "failed";
          parsed.finishedAt = new Date().toISOString();
          parsed.error = {
            code: ErrorCode.TASK_INTERRUPTED,
            message: "Task was interrupted when the local runtime restarted",
          };
        }
        this.records.set(parsed.taskId, parsed);
      } catch {
        // A corrupt/stale task file must not prevent the MCP server starting.
      }
    }
    for (const record of this.records.values()) {
      if (record.status === "failed" && record.error?.code === ErrorCode.TASK_INTERRUPTED) await this.persist(record);
    }
  }

  private fileFor(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  private async persist(record: TaskRecord): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    const temp = `${this.fileFor(record.taskId)}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(redactUnknown(record), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, this.fileFor(record.taskId));
  }

  private activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.status === "running") count += 1;
    return count;
  }

  private canStart(record: TaskRecord): boolean {
    if (this.activeCount() >= this.maxConcurrent) return false;
    // Writer preference prevents a steady stream of reads from starving a
    // queued write for the same project.
    if (
      record.access === "read" &&
      [...this.records.values()].some(
        (other) =>
          other.taskId !== record.taskId &&
          other.status === "queued" &&
          other.projectId === record.projectId &&
          other.access === "write" &&
          other.createdAt <= record.createdAt,
      )
    ) {
      return false;
    }
    for (const other of this.records.values()) {
      if (other.taskId === record.taskId || other.status !== "running" || other.projectId !== record.projectId) continue;
      // Multiple read tasks may share a project; any write task is exclusive.
      if (record.access === "write" || other.access === "write") return false;
    }
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    try {
      let started = true;
      while (started && this.activeCount() < this.maxConcurrent) {
        started = false;
        const queued = [...this.records.values()]
          .filter((record) => record.status === "queued" && this.runtime.has(record.taskId))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const record of queued) {
          if (!this.canStart(record)) continue;
          await this.run(record);
          started = true;
          if (this.activeCount() >= this.maxConcurrent) break;
        }
      }
    } finally {
      this.pumping = false;
      if (this.pumpRequested) {
        this.pumpRequested = false;
        void this.pump();
      }
    }
  }

  private async run(record: TaskRecord): Promise<void> {
    const runtime = this.runtime.get(record.taskId);
    if (!runtime || record.status !== "queued") return;
    record.status = "running";
    record.startedAt = new Date().toISOString();
    record.metrics = { ...(record.metrics ?? {}), queueMs: Math.max(0, Date.now() - Date.parse(record.createdAt)) };
    await this.persist(record);
    void (async () => {
      try {
        const result = await runtime.spec.run({
          signal: runtime.controller.signal,
          report: async (progress) => {
            const current = this.records.get(record.taskId);
            if (!current || current.status !== "running") return;
            current.progress = redactUnknown(progress);
            await this.persist(current);
          },
        });
        const current = this.records.get(record.taskId);
        if (!current) return;
        current.finishedAt = new Date().toISOString();
        current.metrics = { ...(current.metrics ?? {}), durationMs: Math.max(0, Date.parse(current.finishedAt) - Date.parse(current.startedAt ?? current.finishedAt)) };
        if (current.cancelRequested || runtime.controller.signal.aborted) {
          current.status = "canceled";
          current.error = { code: ErrorCode.TASK_CANCELED, message: "Task canceled" };
        } else {
          current.status = "succeeded";
          current.result = redactUnknown(result);
        }
        await this.persist(current);
      } catch (err) {
        const current = this.records.get(record.taskId);
        if (!current) return;
        current.finishedAt = new Date().toISOString();
        current.metrics = { ...(current.metrics ?? {}), durationMs: Math.max(0, Date.parse(current.finishedAt) - Date.parse(current.startedAt ?? current.finishedAt)) };
        current.status = current.cancelRequested || runtime.controller.signal.aborted ? "canceled" : "failed";
        current.error = current.status === "canceled" ? { code: ErrorCode.TASK_CANCELED, message: "Task canceled" } : taskError(err);
        await this.persist(current);
      } finally {
        this.runtime.delete(record.taskId);
        await this.pump();
      }
    })();
  }

  async start(spec: TaskSpec): Promise<TaskRecord> {
    await this.ensureLoaded();
    if (!spec.projectId) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "A projectId is required for a background task");
    const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const record: TaskRecord = {
      taskId,
      projectId: spec.projectId,
      kind: spec.kind,
      access: spec.access ?? "read",
      status: "queued",
      createdAt: new Date().toISOString(),
      ...(spec.targetInstanceId ? { targetInstanceId: spec.targetInstanceId } : {}),
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      ...(spec.inputSummary ? { inputSummary: redactUnknown(spec.inputSummary) as Record<string, unknown> } : {}),
    };
    this.records.set(taskId, record);
    this.runtime.set(taskId, { spec, controller: new AbortController() });
    await this.persist(record);
    await this.pump();
    return { ...record };
  }

  async get(taskId: string): Promise<TaskRecord> {
    await this.ensureLoaded();
    const record = this.records.get(taskId);
    if (!record) throw new DomainError(ErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`, { taskId });
    return { ...record };
  }

  async list(options: TaskListOptions = {}): Promise<TaskRecord[]> {
    await this.ensureLoaded();
    const statuses = options.status ? new Set(Array.isArray(options.status) ? options.status : [options.status]) : undefined;
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
    return [...this.records.values()]
      .filter((record) => (!options.projectId || record.projectId === options.projectId) && (!statuses || statuses.has(record.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    await this.ensureLoaded();
    const record = this.records.get(taskId);
    if (!record) throw new DomainError(ErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`, { taskId });
    if (record.status === "queued") {
      record.status = "canceled";
      record.cancelRequested = true;
      record.finishedAt = new Date().toISOString();
      record.error = { code: ErrorCode.TASK_CANCELED, message: "Task canceled before execution" };
      this.runtime.delete(taskId);
      await this.persist(record);
      await this.pump();
      return { ...record };
    }
    if (record.status === "running") {
      record.cancelRequested = true;
      this.runtime.get(taskId)?.controller.abort();
      await this.persist(record);
    }
    return { ...record };
  }

  /** Cancel unfinished work owned by a transport session that disconnected. */
  async cancelForSession(sessionId: string): Promise<number> {
    await this.ensureLoaded();
    const taskIds = [...this.records.values()]
      .filter((record) => record.sessionId === sessionId && (record.status === "queued" || record.status === "running"))
      .map((record) => record.taskId);
    for (const taskId of taskIds) await this.cancel(taskId);
    return taskIds.length;
  }

  async wait(taskId: string, timeoutMs = 30_000): Promise<TaskRecord> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const record = await this.get(taskId);
      if (record.status !== "queued" && record.status !== "running") return record;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.get(taskId);
  }
}

const managers = new Map<string, TaskManager>();

export function getTaskManager(stateDir: string, maxConcurrent?: number): TaskManager {
  const key = path.resolve(stateDir);
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new TaskManager(key, maxConcurrent);
  managers.set(key, manager);
  return manager;
}

/** Test/embedded-host escape hatch; production code normally keeps managers stable. */
export function resetTaskManagersForTests(): void {
  managers.clear();
}
