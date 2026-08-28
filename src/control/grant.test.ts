import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeControlGrant, consumeControlGrant, issueControlGrant, readControlGrant } from "./grant.js";

describe("local Control Grant", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-grant-"));
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit,Notes";
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("issues an instance/project/app-scoped grant and consumes its bounded action budget", async () => {
    const grant = await issueControlGrant(stateDir, {
      instanceId: "inst_local",
      projectId: "proj",
      apps: ["TextEdit"],
      kinds: ["screenshot", "click"],
      maxActions: 2,
    });
    expect(grant.apps).toEqual(["textedit"]);
    await expect(
      authorizeControlGrant(stateDir, { instanceId: "inst_local", projectId: "proj", appName: "TextEdit", kind: "screenshot" }),
    ).resolves.toMatchObject({ grantId: grant.grantId });
    await consumeControlGrant(stateDir, { instanceId: "inst_local", appName: "TextEdit", kind: "click" });
    const consumed = await consumeControlGrant(stateDir, { instanceId: "inst_local", appName: "TextEdit", kind: "click" });
    expect(consumed.usedActions).toBe(2);
    await expect(readControlGrant(stateDir)).resolves.toBeNull();
  });

  it("refuses apps and instances outside the locally issued scope", async () => {
    await issueControlGrant(stateDir, { instanceId: "inst_local", projectId: "proj", apps: ["TextEdit"] });
    await expect(
      authorizeControlGrant(stateDir, { instanceId: "inst_other", appName: "TextEdit", kind: "click" }),
    ).rejects.toMatchObject({ code: "TARGET_INSTANCE_MISMATCH" });
    await expect(
      authorizeControlGrant(stateDir, { instanceId: "inst_local", appName: "Notes", kind: "click" }),
    ).rejects.toMatchObject({ code: "SENSITIVE_TARGET_BLOCKED" });
  });
});
