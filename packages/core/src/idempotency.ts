import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface IdempotencyEntry {
  key: string;
  createdAt: number;
  summary: unknown;
  /** Hash of the arguments the key was first used with; lets us detect a key reused for a different write. */
  fingerprint?: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | null>;
  put(key: string, summary: unknown, fingerprint?: string): Promise<void>;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class MemoryIdempotencyStore implements IdempotencyStore {
  protected readonly entries = new Map<string, IdempotencyEntry>();
  protected readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<IdempotencyEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async put(key: string, summary: unknown, fingerprint?: string): Promise<void> {
    this.entries.set(key, { key, createdAt: Date.now(), summary, fingerprint });
  }
}

/**
 * Idempotency store that survives restarts. Entries are kept in one JSON file and rewritten
 * atomically (write to a temp file, then rename) after every put.
 */
export class FileIdempotencyStore extends MemoryIdempotencyStore {
  private readonly filePath: string;

  constructor(filePath: string, ttlMs = DEFAULT_TTL_MS) {
    super(ttlMs);
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, IdempotencyEntry>;
        const now = Date.now();
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v.createdAt === "number" && now - v.createdAt <= ttlMs) this.entries.set(k, v);
        }
      } catch {
        // A corrupt store must not block writes; start empty. Duplicates are still guarded by
        // the agent checking upstream before retrying.
      }
    }
  }

  override async put(key: string, summary: unknown, fingerprint?: string): Promise<void> {
    await super.put(key, summary, fingerprint);
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

const CONTROL_FIELDS = new Set(["dry_run", "idempotency_key"]);

/** Hash of a write's business arguments (everything except dry_run / idempotency_key), at every depth. */
export function argsFingerprint(toolName: string, scope: string, args: Record<string, unknown>): string {
  const business: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!CONTROL_FIELDS.has(k) && v !== undefined) business[k] = v;
  return createHash("sha256").update(`${toolName}|${scope}|${canonicalJson(business)}`).digest("hex");
}

/** @deprecated kept for API compatibility; same as argsFingerprint. */
export function idempotencyKey(toolName: string, scope: string, args: Record<string, unknown>): string {
  return argsFingerprint(toolName, scope, args);
}
