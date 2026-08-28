import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { controlAllowlist, isAppAllowed, isSensitiveApp } from "./policy.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 60;
const DEFAULT_MAX_ACTIONS = 20;
const MAX_ACTIONS = 100;
const GRANT_FILE = "GRANT.json";

export type ControlGrantKind = "screenshot" | "click" | "type" | "key";

export interface ControlGrant {
  version: 1;
  grantId: string;
  instanceId: string;
  projectId: string;
  apps: string[];
  kinds: ControlGrantKind[];
  issuedAt: number;
  expiresAt: number;
  maxActions: number;
  usedActions: number;
}

export interface IssueControlGrantInput {
  instanceId: string;
  projectId: string;
  apps: string[];
  kinds?: ControlGrantKind[];
  minutes?: number;
  maxActions?: number;
}

export interface AuthorizeControlGrantInput {
  instanceId: string;
  projectId?: string;
  appName?: string;
  kind?: ControlGrantKind;
}

const ControlGrantSchema = z.object({
  version: z.literal(1),
  grantId: z.string().regex(/^cgrant_[0-9a-f-]{36}$/i),
  instanceId: z.string().min(1),
  projectId: z.string().min(1),
  apps: z.array(z.string().min(1)).min(1),
  kinds: z.array(z.enum(["screenshot", "click", "type", "key"])).min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  maxActions: z.number().int().min(1).max(MAX_ACTIONS),
  usedActions: z.number().int().nonnegative(),
}) satisfies z.ZodType<ControlGrant>;

let mutationChain: Promise<void> = Promise.resolve();

function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

function controlDir(stateDir: string): string {
  return path.join(stateDir, "control");
}

function grantPath(stateDir: string): string {
  return path.join(controlDir(stateDir), GRANT_FILE);
}

function normalizeApp(value: string): string {
  return value.trim().toLowerCase();
}

function effectiveMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(1, Math.floor(value)));
}

function effectiveMaxActions(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ACTIONS;
  return Math.min(MAX_ACTIONS, Math.max(1, Math.floor(value)));
}

async function writeGrant(stateDir: string, grant: ControlGrant): Promise<void> {
  const dir = controlDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const target = grantPath(stateDir);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(grant, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await fs.rename(temp, target);
  await fs.chmod(target, FILE_MODE).catch(() => undefined);
}

async function readRawGrant(stateDir: string): Promise<ControlGrant | null> {
  try {
    const parsed = ControlGrantSchema.safeParse(JSON.parse(await fs.readFile(grantPath(stateDir), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function issueControlGrant(stateDir: string, input: IssueControlGrantInput): Promise<ControlGrant> {
  return withMutationLock(async () => {
    const liveAllowlist = controlAllowlist();
    const apps = Array.from(
      new Set(
        input.apps
          .map((app) => app.trim())
          .filter((app) => app.length > 0 && !isSensitiveApp(app) && isAppAllowed(app, liveAllowlist))
          .map(normalizeApp),
      ),
    );
    if (apps.length === 0) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        "A control grant requires at least one non-sensitive app from CHATGPT2CODEX_CONTROL_ALLOWLIST",
      );
    }
    const defaultKinds: ControlGrantKind[] = ["screenshot", "click", "type", "key"];
    const kinds: ControlGrantKind[] = Array.from(new Set(input.kinds?.length ? input.kinds : defaultKinds));
    const now = Date.now();
    const grant: ControlGrant = {
      version: 1,
      grantId: `cgrant_${randomUUID()}`,
      instanceId: input.instanceId,
      projectId: input.projectId,
      apps,
      kinds,
      issuedAt: now,
      expiresAt: now + effectiveMinutes(input.minutes) * 60_000,
      maxActions: effectiveMaxActions(input.maxActions),
      usedActions: 0,
    };
    await writeGrant(stateDir, grant);
    return grant;
  });
}

export async function clearControlGrant(stateDir: string): Promise<void> {
  await withMutationLock(async () => {
    await fs.unlink(grantPath(stateDir)).catch(() => undefined);
  });
}

export async function readControlGrant(stateDir: string, now = Date.now()): Promise<ControlGrant | null> {
  const grant = await readRawGrant(stateDir);
  if (!grant) return null;
  if (now >= grant.expiresAt || grant.usedActions >= grant.maxActions) {
    await clearControlGrant(stateDir);
    return null;
  }
  return grant;
}

function assertGrantScope(grant: ControlGrant, input: AuthorizeControlGrantInput): void {
  if (grant.instanceId !== input.instanceId) {
    throw new DomainError(ErrorCode.TARGET_INSTANCE_MISMATCH, "The local control grant belongs to another MCP instance", {
      requested: input.instanceId,
      actual: grant.instanceId,
    });
  }
  if (input.projectId && input.projectId !== grant.projectId) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "The local control grant belongs to another project", {
      requested: input.projectId,
      actual: grant.projectId,
    });
  }
  if (input.appName) {
    if (isSensitiveApp(input.appName) || !grant.apps.includes(normalizeApp(input.appName))) {
      throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is outside the local control grant: ${input.appName}`);
    }
    if (!isAppAllowed(input.appName, controlAllowlist())) {
      throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is no longer on the live control allowlist: ${input.appName}`);
    }
  }
  if (input.kind && !grant.kinds.includes(input.kind)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Action kind is outside the local control grant: ${input.kind}`);
  }
}

export async function authorizeControlGrant(
  stateDir: string,
  input: AuthorizeControlGrantInput,
): Promise<ControlGrant> {
  const grant = await readControlGrant(stateDir);
  if (!grant) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "No active local Control Grant. Grant Computer Use from the Mac status bar or local CLI first.",
    );
  }
  assertGrantScope(grant, input);
  return grant;
}

/** Atomically authorize and consume one action from the local bounded grant. */
export async function consumeControlGrant(
  stateDir: string,
  input: AuthorizeControlGrantInput,
): Promise<ControlGrant> {
  return withMutationLock(async () => {
    const grant = await readRawGrant(stateDir);
    if (!grant || Date.now() >= grant.expiresAt || grant.usedActions >= grant.maxActions) {
      await fs.unlink(grantPath(stateDir)).catch(() => undefined);
      throw new DomainError(ErrorCode.LEASE_REQUIRED, "The local Control Grant is missing, expired, or exhausted");
    }
    assertGrantScope(grant, input);
    const next = { ...grant, usedActions: grant.usedActions + 1 };
    if (next.usedActions >= next.maxActions) {
      await fs.unlink(grantPath(stateDir)).catch(() => undefined);
    } else {
      await writeGrant(stateDir, next);
    }
    return next;
  });
}

export { DEFAULT_MAX_ACTIONS, DEFAULT_TTL_MINUTES, MAX_ACTIONS, MAX_TTL_MINUTES };
