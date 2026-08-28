import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { findProject, scanWorkspace } from "./registry.js";
import type { ProjectRegistryEntry } from "../types.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

describe("scanWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-ws-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds git repos as project candidates and derives metadata", async () => {
    const projDir = path.join(root, "alpha-app");
    await mkdir(projDir, { recursive: true });
    await initGitRepo(projDir);
    await writeFile(path.join(projDir, "package.json"), "{}");
    await writeFile(path.join(projDir, "AGENTS.md"), "# rules");
    await writeFile(path.join(projDir, "untracked.txt"), "x");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ProjectRegistryEntry;
    expect(entry.projectId).toBe("alpha-app");
    expect(entry.name).toBe("alpha-app");
    expect(entry.root).toBe(projDir);
    expect(entry.packageHints).toContain("node");
    expect(entry.hasAgentsMd).toBe(true);
    expect(entry.hasCodeBrain).toBe(false);
    expect(entry.dirty).toBe(true); // untracked.txt makes it dirty
    expect(entry.aliases).toContain("alpha-app");
  });

  it("detects project marker folders without .git (e.g. package.json only)", async () => {
    const projDir = path.join(root, "flutter-app");
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, "pubspec.yaml"), "name: flutter_app");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.packageHints).toContain("flutter");
    expect(entries[0]?.branch).toBeUndefined();
  });

  it("detects .chatgpt2codex project marker folders", async () => {
    const projDir = path.join(root, "chatgpt2codex-project");
    await mkdir(path.join(projDir, ".chatgpt2codex"), { recursive: true });

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.projectId).toBe("chatgpt2codex-project");
  });

  it("includes the workspace root itself when it is a project folder", async () => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "single-project" }));

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectId: path.basename(root).toLowerCase(),
      name: path.basename(root),
      root,
      packageHints: ["node"],
    });
  });

  it("excludes plain folders with no project markers", async () => {
    await mkdir(path.join(root, "just-a-folder"), { recursive: true });
    await writeFile(path.join(root, "just-a-folder", "notes.txt"), "hi");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(0);
  });

  it("discovers projects two directory levels below a container workspace", async () => {
    const projDir = path.join(root, "100_xxx", "projectname");
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, "package.json"), "{}");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectId: "projectname",
      name: "projectname",
      root: projDir,
    });
    expect(entries[0]?.aliases).toContain(path.join("100_xxx", "projectname"));
    const byPathAlias = findProject(entries, { name: path.join("100_xxx", "projectname") });
    expect(byPathAlias).toMatchObject({ ok: true, entry: { root: projDir } });
  });

  it("honors an explicit scan depth and does not descend through a project boundary", async () => {
    const deepProject = path.join(root, "group", "nested", "deep-project");
    await mkdir(deepProject, { recursive: true });
    await writeFile(path.join(deepProject, "package.json"), "{}");

    expect(await scanWorkspace(root, { depth: 1 })).toHaveLength(0);
    expect(await scanWorkspace(root, { depth: 2 })).toHaveLength(0);
    expect(await scanWorkspace(root, { depth: 3 })).toHaveLength(1);

    const outerProject = path.join(root, "outer-project");
    const innerProject = path.join(outerProject, "fixtures", "inner-project");
    await mkdir(innerProject, { recursive: true });
    await writeFile(path.join(outerProject, "package.json"), "{}");
    await writeFile(path.join(innerProject, "package.json"), "{}");

    const boundaryEntries = await scanWorkspace(root, { depth: 5 });
    expect(boundaryEntries.filter((entry) => entry.root === outerProject)).toHaveLength(1);
    expect(boundaryEntries.some((entry) => entry.root === innerProject)).toBe(false);
  });

  it("skips hidden directories", async () => {
    const hidden = path.join(root, ".config");
    await mkdir(hidden, { recursive: true });
    await initGitRepo(hidden);

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(0);
  });

  it("can include hidden project directories when requested", async () => {
    const hidden = path.join(root, ".private", "nested-project");
    await mkdir(hidden, { recursive: true });
    await writeFile(path.join(hidden, "package.json"), "{}");

    const entries = await scanWorkspace(root, { includeHidden: true });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.root).toBe(hidden);
  });

  it("detects hasCodeBrain when .ai/bin/ai exists", async () => {
    const projDir = path.join(root, "go-service");
    await mkdir(path.join(projDir, ".ai", "bin"), { recursive: true });
    await writeFile(path.join(projDir, ".ai", "bin", "ai"), "#!/bin/sh\n");
    await writeFile(path.join(projDir, "go.mod"), "module go-service\n");

    const entries = await scanWorkspace(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hasCodeBrain).toBe(true);
    expect(entries[0]?.packageHints).toContain("go");
  });

  it("throws WORKSPACE_NOT_READY when root does not exist", async () => {
    await expect(scanWorkspace(path.join(root, "does-not-exist"))).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_NOT_READY,
    });
  });
});

describe("findProject", () => {
  const alpha: ProjectRegistryEntry = {
    projectId: "alpha-app",
    name: "alpha-app",
    root: "/workspace/alpha-app",
    aliases: ["alpha-app", "alpha"],
    branch: "develop",
    dirty: true,
  };
  const beta: ProjectRegistryEntry = {
    projectId: "beta-app",
    name: "beta-app",
    root: "/workspace/beta-app",
    aliases: ["beta-app", "beta"],
  };
  const gamma: ProjectRegistryEntry = {
    projectId: "gamma-app",
    name: "gamma-app",
    root: "/workspace/gamma-app",
    aliases: ["gamma-app"],
  };
  const entries = [alpha, beta, gamma];

  it("resolves exact match by projectId", () => {
    const result = findProject(entries, { projectId: "beta-app" });
    expect(result).toEqual({ ok: true, entry: beta });
  });

  it("returns not_found for unknown projectId", () => {
    const result = findProject(entries, { projectId: "nope" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves exact single match by name", () => {
    const result = findProject(entries, { name: "alpha-app" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("resolves exact single match by alias (case/hyphen/space insensitive)", () => {
    const result = findProject(entries, { name: "Beta" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("beta-app");
  });

  it("resolves alias exact match", () => {
    const result = findProject(entries, { name: "alpha" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("returns ambiguous with candidates when multiple entries share a normalized name", () => {
    const dupA: ProjectRegistryEntry = {
      projectId: "shop-a",
      name: "shop",
      root: "/ws/shop-a",
      aliases: ["shop"],
    };
    const dupB: ProjectRegistryEntry = {
      projectId: "shop-b",
      name: "shop",
      root: "/ws/shop-b",
      aliases: ["shop"],
    };
    const result = findProject([dupA, dupB], { name: "shop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("falls back to fuzzy match with a clear gap", () => {
    const result = findProject(entries, { name: "alpah-app" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.projectId).toBe("alpha-app");
  });

  it("returns ambiguous top3 when fuzzy match has no clear gap", () => {
    const close = [
      { ...alpha, projectId: "aaa", name: "aaa", aliases: ["aaa"] },
      { ...alpha, projectId: "aab", name: "aab", aliases: ["aab"] },
      { ...alpha, projectId: "aac", name: "aac", aliases: ["aac"] },
    ];
    const result = findProject(close, { name: "aad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates?.length).toBeGreaterThan(0);
    }
  });

  it("returns not_found when neither projectId nor name is given", () => {
    const result = findProject(entries, {});
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found on empty registry with a name query", () => {
    const result = findProject([], { name: "anything" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
