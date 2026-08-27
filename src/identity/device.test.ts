import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_IDENTITY_FILE,
  ensureDeviceIdentity,
  mcpResourceName,
  mcpServerName,
  normalizeDisplayName,
  requireDisplayName,
} from "./device.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function newStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-device-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("device identity", () => {
  it("creates one stable instance id and persists a custom display name", async () => {
    const stateDir = await newStateDir();
    const first = await ensureDeviceIdentity(stateDir);
    const renamed = await ensureDeviceIdentity(stateDir, { displayName: "Office Mac" });
    const reloaded = await ensureDeviceIdentity(stateDir);

    expect(first.instanceId).toMatch(/^inst_[A-Za-z0-9-]{16,}$/u);
    expect(renamed.instanceId).toBe(first.instanceId);
    expect(renamed.displayName).toBe("Office Mac");
    expect(reloaded).toEqual(renamed);
    expect(JSON.parse(await fs.readFile(path.join(stateDir, DEVICE_IDENTITY_FILE), "utf8"))).toMatchObject({
      instanceId: first.instanceId,
      displayName: "Office Mac",
    });
  });

  it("keeps identities in separate state directories distinct", async () => {
    const first = await ensureDeviceIdentity(await newStateDir());
    const second = await ensureDeviceIdentity(await newStateDir());
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(mcpServerName(first)).not.toBe(mcpServerName(second));
    expect(mcpResourceName(first)).toContain(first.displayName);
  });

  it("normalizes names and rejects blank explicit names", () => {
    expect(normalizeDisplayName("  Office\n  Mac  ")).toBe("Office Mac");
    expect(normalizeDisplayName("\u0000\u0001")).toBeUndefined();
    expect(() => requireDisplayName("   ")).toThrow(/visible character/u);
  });
});

