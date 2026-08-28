import { promises as fs } from "node:fs";
import path from "node:path";

export interface IndexedMatch {
  path: string;
  line: number;
  snippet: string;
  score?: number;
}

interface IndexedFile {
  mtimeMs: number;
  size: number;
  symbols: Array<{ name: string; line: number; snippet: string }>;
  imports: Array<{ value: string; line: number; snippet: string }>;
}

interface ProjectIndex {
  files: Map<string, IndexedFile>;
  scannedAt: number;
}

const indexes = new Map<string, ProjectIndex>();
const SKIP_DIRS = new Set([".git", "node_modules", ".ai", ".codex", "dist", "build", ".next", ".venv", "vendor"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".swift"]);
const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function extract(content: string): IndexedFile {
  const symbols: IndexedFile["symbols"] = [];
  const imports: IndexedFile["imports"] = [];
  const lines = content.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const symbol = line.match(/^(?:export\s+default\s+|export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/u)
      ?? line.match(/^(?:async\s+)?(?:def|fn|struct|trait)\s+([A-Za-z_][\w]*)/u);
    if (symbol?.[1]) symbols.push({ name: symbol[1], line: index + 1, snippet: line.slice(0, 400) });
    if (/^(?:import\b|export\s+.*\s+from\b|const\s+.*=\s*require\(|use\s+)/u.test(line)) {
      imports.push({ value: line.slice(0, 400), line: index + 1, snippet: line.slice(0, 400) });
    }
  }
  return { mtimeMs: 0, size: Buffer.byteLength(content, "utf8"), symbols, imports };
}

async function walk(root: string, dir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, path.join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    files.push(path.relative(root, path.join(dir, entry.name)));
  }
}

async function refresh(root: string): Promise<ProjectIndex> {
  const key = path.resolve(root);
  const index = indexes.get(key) ?? { files: new Map<string, IndexedFile>(), scannedAt: 0 };
  const paths: string[] = [];
  await walk(key, key, paths);
  const seen = new Set(paths);
  for (const rel of paths) {
    const abs = path.join(key, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_INDEX_FILE_BYTES) continue;
    const previous = index.files.get(rel);
    if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
    const content = await fs.readFile(abs, "utf8").catch(() => "");
    const next = extract(content);
    next.mtimeMs = stat.mtimeMs;
    next.size = stat.size;
    index.files.set(rel, next);
  }
  for (const rel of index.files.keys()) if (!seen.has(rel)) index.files.delete(rel);
  index.scannedAt = Date.now();
  indexes.set(key, index);
  return index;
}

export async function indexedSearch(
  root: string,
  query: string,
  mode: "symbol" | "semantic",
  cap: number,
): Promise<{ matches: IndexedMatch[]; backend: string }> {
  const index = await refresh(root);
  const needle = query.toLowerCase();
  const matches: IndexedMatch[] = [];
  for (const [file, entry] of index.files) {
    for (const symbol of entry.symbols) {
      const haystack = `${symbol.name} ${symbol.snippet}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({ path: file, line: symbol.line, snippet: symbol.snippet, score: symbol.name.toLowerCase() === needle ? 1 : 0.8 });
    }
    if (mode === "semantic") {
      for (const imported of entry.imports) {
        if (!imported.value.toLowerCase().includes(needle)) continue;
        matches.push({ path: file, line: imported.line, snippet: imported.snippet, score: 0.6 });
      }
    }
    if (matches.length >= cap * 2) break;
  }
  matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path) || a.line - b.line);
  return { matches: matches.slice(0, cap), backend: mode === "symbol" ? "incremental-symbol-index" : "incremental-semantic-index" };
}

export function clearProjectIndex(root?: string): void {
  if (!root) {
    indexes.clear();
    return;
  }
  indexes.delete(path.resolve(root));
}
