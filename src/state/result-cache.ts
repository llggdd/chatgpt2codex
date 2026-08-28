import path from "node:path";

interface CacheEntry {
  expiresAt: number;
  value: unknown;
  touchedAt: number;
}

const DEFAULT_TTL_MS = 3_000;
const MAX_ENTRIES = 128;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function cacheKey(toolName: string, input: unknown, scope?: string): string {
  return `${scope ?? ""}|${toolName}|${JSON.stringify(stableValue(input))}`;
}

/** In-memory per-runtime cache for fast, safe read-only MCP calls. */
export class ResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  readonly ttlMs: number;

  constructor(ttlMs?: number) {
    const env = Number.parseInt(process.env.CHATGPT2CODEX_RESULT_CACHE_TTL_MS ?? "", 10);
    const candidate = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : Number.isFinite(env) ? env : DEFAULT_TTL_MS;
    this.ttlMs = Math.min(30_000, Math.max(250, Math.floor(candidate)));
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    entry.touchedAt = Date.now();
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    const now = Date.now();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs, touchedAt: now });
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (oldest) this.entries.delete(oldest[0]);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

const caches = new Map<string, ResultCache>();

export function getResultCache(stateDir: string): ResultCache {
  const key = path.resolve(stateDir);
  const existing = caches.get(key);
  if (existing) return existing;
  const cache = new ResultCache();
  caches.set(key, cache);
  return cache;
}

export function resetResultCachesForTests(): void {
  caches.clear();
}
