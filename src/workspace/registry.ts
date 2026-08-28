import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";

const execFileAsync = promisify(execFile);

/** Package/tooling marker files used to detect `packageHints` (PRD §8.1). */
const PACKAGE_MARKERS: Array<{ file: string; hint: string }> = [
  { file: "package.json", hint: "node" },
  { file: "pubspec.yaml", hint: "flutter" },
  { file: "go.mod", hint: "go" },
  { file: "Cargo.toml", hint: "rust" },
  { file: "requirements.txt", hint: "python" },
];

/** Extra project-marker files that qualify a directory as a project even without .git. */
const PROJECT_MARKER_FILES = [
  ".git",
  "package.json",
  "pubspec.yaml",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  ".chatgpt2codex",
];

/**
 * A workspace can be a lightweight container (for example `~/codes`) rather
 * than a project itself. Keep recursive discovery bounded and avoid walking
 * dependency/build trees that can contain thousands of directories.
 *
 * `depth` is the number of descendant directory levels below the workspace
 * root. The default therefore discovers `codes/project` and
 * `codes/group/project`, while a project directory stops traversal at its
 * marker boundary.
 */
export const DEFAULT_SCAN_DEPTH = 2;
export const MAX_SCAN_DEPTH = 5;
const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "coverage",
]);

export interface ScanWorkspaceOptions {
  /** Number of child-directory levels to inspect below `root` (0-5). */
  depth?: number;
  /** Include dot-prefixed directories, except protected dependency/build trees. */
  includeHidden?: boolean;
}

function effectiveScanDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(0, Math.floor(value)));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".git"));
}

async function hasAnyProjectMarker(dir: string): Promise<boolean> {
  for (const marker of PROJECT_MARKER_FILES) {
    if (await pathExists(path.join(dir, marker))) return true;
  }
  return false;
}

/** `git rev-parse --abbrev-ref HEAD`, tolerating non-git or detached/broken repos. */
async function getBranch(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, timeout: 5000 },
    );
    const branch = stdout.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** `git status --porcelain`, tolerating non-git dirs. Returns true if any output. */
async function getDirty(dir: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: dir, timeout: 10000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}

async function detectPackageHints(dir: string): Promise<string[]> {
  const hints: string[] = [];
  for (const { file, hint } of PACKAGE_MARKERS) {
    if (await pathExists(path.join(dir, file))) hints.push(hint);
  }
  return hints;
}

/** Normalize a name/alias for comparison: lowercase, collapse whitespace/hyphens. */
function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

function slugify(name: string): string {
  const slug = normalize(name).replace(/[^a-z0-9-]/g, "");
  return slug.length > 0 ? slug : name.trim().toLowerCase();
}

/**
 * Scan the workspace root for candidate projects (git repos / project marker
 * folders) and build registry entries (PRD §8.1 workspace_list_projects,
 * §10 registry shape).
 */
export async function scanWorkspace(root: string, options: ScanWorkspaceOptions = {}): Promise<ProjectRegistryEntry[]> {
  const workspaceRoot = path.resolve(root);
  const maxDepth = effectiveScanDepth(options.depth);
  const includeHidden = options.includeHidden === true;
  const entries: ProjectRegistryEntry[] = [];
  const nowIso = new Date().toISOString();

  const pushProject = async (dir: string, name: string, relativePath: string): Promise<boolean> => {
    const isGit = await isGitRepo(dir);
    const hasMarker = isGit || (await hasAnyProjectMarker(dir));
    if (!hasMarker) return false;

    const [branch, dirty, packageHints, hasAgentsMd, hasCodeBrain] = await Promise.all([
      isGit ? getBranch(dir) : Promise.resolve(undefined),
      isGit ? getDirty(dir) : Promise.resolve(undefined),
      detectPackageHints(dir),
      pathExists(path.join(dir, "AGENTS.md")).then(
        async (has) => has || (await pathExists(path.join(dir, "CLAUDE.md"))),
      ),
      pathExists(path.join(dir, ".ai", "bin", "ai")),
    ]);

    const projectId = slugify(name);
    const aliases = Array.from(
      new Set(
        [name, projectId, name.toLowerCase(), relativePath]
          .filter((alias) => alias.length > 0 && alias !== ".")
          .map((alias) => alias),
      ),
    );

    entries.push({
      projectId,
      name,
      root: dir,
      aliases,
      branch,
      dirty,
      hasAgentsMd,
      hasCodeBrain,
      packageHints,
      lastSeenAt: nowIso,
    });
    return true;
  };

  const shouldDescend = (dirent: import("node:fs").Dirent): boolean => {
    if (!dirent.isDirectory() || SKIP_DIRECTORY_NAMES.has(dirent.name)) return false;
    if (!includeHidden && dirent.name.startsWith(".")) return false;
    return true;
  };

  const readChildren = async (dir: string, isRoot: boolean): Promise<import("node:fs").Dirent[]> => {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) {
        throw new DomainError(
          ErrorCode.WORKSPACE_NOT_READY,
          `Cannot read workspace root: ${(err as Error).message}`,
          { root: workspaceRoot },
        );
      }
      // A single unreadable child must not make the rest of a workspace
      // unusable (permissions and broken mounts are common in monorepos).
      return [];
    }
  };

  const scanDirectory = async (
    dir: string,
    name: string,
    relativePath: string,
    level: number,
    isRoot: boolean,
    rootChildren?: import("node:fs").Dirent[],
  ): Promise<void> => {
    // A marker directory is a project boundary. This avoids accidentally
    // registering package.json files inside node_modules or nested fixtures.
    const isProject = await pushProject(dir, name, relativePath);
    if (isProject || level >= maxDepth) return;

    const children = rootChildren ?? (await readChildren(dir, isRoot));
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of children) {
      if (!shouldDescend(dirent)) continue;
      const childRelativePath = relativePath === "." ? dirent.name : path.join(relativePath, dirent.name);
      await scanDirectory(path.join(dir, dirent.name), dirent.name, childRelativePath, level + 1, false);
    }
  };

  const rootChildren = await readChildren(workspaceRoot, true);
  await scanDirectory(workspaceRoot, path.basename(workspaceRoot), ".", 0, true, rootChildren);

  return entries;
}

/** Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prevRow = new Array<number>(n + 1);
  const currRow = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        (prevRow[j] ?? Infinity) + 1,
        (currRow[j - 1] ?? Infinity) + 1,
        (prevRow[j - 1] ?? Infinity) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prevRow[j] = currRow[j] as number;
  }
  return prevRow[n] as number;
}

/** Fuzzy match threshold/gap tuning for PRD §9.1 resolveProject. */
const FUZZY_MAX_DISTANCE_RATIO = 0.4; // distance must be <= 40% of normalized query length
const FUZZY_GAP_MIN = 2; // best must beat runner-up by this much to auto-select

/**
 * Resolve a project by id or name/alias against known registry entries,
 * implementing the name-resolution algorithm in PRD §9.1 (exact match,
 * ambiguous-candidates, fuzzy fallback).
 */
export function findProject(
  entries: ProjectRegistryEntry[],
  q: { projectId?: string; name?: string },
):
  | { ok: true; entry: ProjectRegistryEntry }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: ProjectRegistryEntry[] } {
  if (q.projectId) {
    const found = entries.find((e) => e.projectId === q.projectId);
    if (found) return { ok: true, entry: found };
    return { ok: false, reason: "not_found" };
  }

  if (!q.name || q.name.trim().length === 0) {
    return { ok: false, reason: "not_found" };
  }

  const norm = normalize(q.name);

  const exact = entries.filter((e) => {
    const candidates = [e.projectId, e.name, ...e.aliases];
    return candidates.some((c) => normalize(c) === norm);
  });

  if (exact.length === 1) return { ok: true, entry: exact[0] as ProjectRegistryEntry };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };

  if (entries.length === 0) return { ok: false, reason: "not_found" };

  const scored = entries
    .map((e) => {
      const names = [e.projectId, e.name, ...e.aliases].map(normalize);
      const dist = Math.min(...names.map((n) => editDistance(norm, n)));
      return { entry: e, dist };
    })
    .sort((a, b) => a.dist - b.dist);

  const best = scored[0];
  const runnerUp = scored[1];
  const maxAllowed = Math.max(1, Math.ceil(norm.length * FUZZY_MAX_DISTANCE_RATIO));

  if (best && best.dist <= maxAllowed) {
    const gapLargeEnough = !runnerUp || runnerUp.dist - best.dist >= FUZZY_GAP_MIN;
    if (gapLargeEnough) {
      return { ok: true, entry: best.entry };
    }
  }

  const top3 = scored.slice(0, 3).map((s) => s.entry);
  return { ok: false, reason: "ambiguous", candidates: top3 };
}
