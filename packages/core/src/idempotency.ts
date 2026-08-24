import { createHash } from "node:crypto";

export interface IdempotencyEntry {
  key: string;
  createdAt: number;
  summary: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | null>;
  put(key: string, summary: unknown): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
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

  async put(key: string, summary: unknown): Promise<void> {
    this.entries.set(key, { key, createdAt: Date.now(), summary });
  }
}

export function idempotencyKey(toolName: string, scope: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(`${toolName}|${scope}|${canonical}`).digest("hex");
}
