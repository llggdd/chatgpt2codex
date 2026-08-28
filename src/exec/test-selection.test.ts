import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { selectVerificationCommands } from "./test-selection.js";

describe("selectVerificationCommands", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-test-selection-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prefers targeted test/typecheck scripts for changed files", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "echo test", typecheck: "echo types", build: "echo build", deploy: "echo no" } }),
    );
    const selected = await selectVerificationCommands(root, ["src/widget.ts"]);
    expect(selected.map((command) => command.commandId)).toEqual(["npm:typecheck", "npm:test", "npm:build"]);
  });

  it("rejects an explicit unsafe or undiscovered command", async () => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo test", deploy: "echo deploy" } }));
    await expect(selectVerificationCommands(root, ["src/a.ts"], ["npm:deploy"])).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
  });
});
