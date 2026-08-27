import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Stable identity for one chatgpt2codex installation/runtime.
 *
 * The identity is deliberately separate from the project registry. A user
 * can point two installations at the same workspace while still keeping the
 * MCP registrations distinguishable (for example, a desktop and a laptop).
 */
export interface DeviceIdentity {
  version: 1;
  instanceId: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceIdentityOverrides {
  /** Optional explicit identity, primarily useful for managed deployments. */
  instanceId?: string;
  /** User-facing name configured in the desktop launcher or environment. */
  displayName?: string;
}

export const DEVICE_IDENTITY_FILE = "device.json";
export const DEFAULT_DISPLAY_NAME = "ChatGPT To Codex";
export const MAX_DISPLAY_NAME_LENGTH = 80;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const INSTANCE_ID_PATTERN = /^inst_[A-Za-z0-9-]{16,80}$/u;

const DeviceIdentitySchema = z.object({
  version: z.literal(1),
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

function generatedInstanceId(): string {
  return `inst_${randomUUID()}`;
}

function hostDisplayName(): string {
  const localHost = hostname().trim().replace(/\.+$/u, "");
  if (!localHost) return DEFAULT_DISPLAY_NAME;
  return `${DEFAULT_DISPLAY_NAME} (${localHost})`;
}

/** Normalize user input without allowing control characters into MCP metadata. */
export function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Validate a name supplied by an explicit CLI/UI operation. */
export function requireDisplayName(value: string): string {
  const normalized = normalizeDisplayName(value);
  if (!normalized) {
    throw new Error("Device display name must contain at least one visible character");
  }
  return normalized;
}

function normalizeInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return INSTANCE_ID_PATTERN.test(normalized) ? normalized : undefined;
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(stateDir, DIR_MODE);
  } catch {
    // Non-POSIX filesystems (notably some Windows mounts) may not support it.
  }
}

async function readIdentity(stateDir: string): Promise<DeviceIdentity | undefined> {
  try {
    const raw = await readFile(join(stateDir, DEVICE_IDENTITY_FILE), "utf8");
    const parsed = DeviceIdentitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeIdentity(stateDir: string, identity: DeviceIdentity): Promise<void> {
  await ensureStateDir(stateDir);
  const target = join(stateDir, DEVICE_IDENTITY_FILE);
  const temp = join(stateDir, `.${DEVICE_IDENTITY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(identity, null, 2), { mode: FILE_MODE, encoding: "utf8" });
  await rename(temp, target);
  try {
    await chmod(target, FILE_MODE);
  } catch {
    // Best effort on filesystems without POSIX permission bits.
  }
}

/**
 * Load or create the stable identity and apply optional runtime overrides.
 * Display-name changes are persisted, while a malformed override is ignored
 * so a bad environment variable cannot prevent the server from starting.
 */
export async function ensureDeviceIdentity(
  stateDir: string,
  overrides: DeviceIdentityOverrides = {},
): Promise<DeviceIdentity> {
  const existing = await readIdentity(stateDir);
  const now = Date.now();
  const instanceId = normalizeInstanceId(overrides.instanceId) ?? existing?.instanceId ?? generatedInstanceId();
  const displayName = normalizeDisplayName(overrides.displayName) ?? existing?.displayName ?? hostDisplayName();
  const identity: DeviceIdentity = {
    version: 1,
    instanceId,
    displayName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing && existing.displayName === displayName && existing.instanceId === instanceId ? existing.updatedAt : now,
  };

  if (
    !existing ||
    existing.instanceId !== identity.instanceId ||
    existing.displayName !== identity.displayName ||
    existing.updatedAt !== identity.updatedAt
  ) {
    await writeIdentity(stateDir, identity);
  }
  return identity;
}

/** Stable fallback used by unit tests or callers that construct a context manually. */
export function fallbackDeviceIdentity(): DeviceIdentity {
  return {
    version: 1,
    instanceId: "inst_unconfigured-runtime",
    displayName: DEFAULT_DISPLAY_NAME,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function shortInstanceId(identityOrInstanceId: DeviceIdentity | string): string {
  const raw = typeof identityOrInstanceId === "string" ? identityOrInstanceId : identityOrInstanceId.instanceId;
  return raw.replace(/^inst_/u, "").slice(0, 12);
}

/** Name advertised to MCP clients. Includes the stable suffix to prevent registration collisions. */
export function mcpServerName(identity: DeviceIdentity): string {
  return `chatgpt2codex-${shortInstanceId(identity)}`;
}

/** Resource label used by OAuth protected-resource metadata. */
export function mcpResourceName(identity: DeviceIdentity): string {
  return `${identity.displayName} [${shortInstanceId(identity)}]`;
}

/** Name shown by the Custom GPT Actions health endpoint. */
export function actionBridgeName(identity: DeviceIdentity): string {
  return `chatgpt2codex-actions-${shortInstanceId(identity)}`;
}

