import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactDeep } from "./redact.js";export interface AuditRecord {
  ts: string;
  seq: number;
  actor: string;
  connector: string;
  tool: string;
  action: "read" | "dry_run" | "execute" | "denied" | "error";
  status?: "ok" | "error";
  durationMs?: number;
  input?: unknown;
  summary?: unknown;
  error?: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditSink {
  append(record: Omit<AuditRecord, "seq" | "prevHash" | "hash" | "ts">): AuditRecord;
}

export class MemoryAuditLog implements AuditSink {
  readonly records: AuditRecord[] = [];
  protected prevHash = GenesisHash;

  append(record: Omit<AuditRecord, "seq" | "prevHash" | "hash" | "ts">): AuditRecord {
    const ts = new Date().toISOString();
    const seq = this.records.length + 1;
    const base = {
      ...record,
      input: record.input === undefined ? undefined : redactDeep(record.input),
      summary: record.summary === undefined ? undefined : redactDeep(record.summary),
      error: record.error === undefined ? undefined : redactDeep(record.error),
      ts,
      seq,
      prevHash: this.prevHash
    };
    const hash = hashRecord(base);
    const full: AuditRecord = { ...base, hash };
    this.records.push(full);
    this.prevHash = hash;
    return full;
  }

  verify(): boolean {
    let prev = GenesisHash;
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i]!;
      if (rec.seq !== i + 1 || rec.prevHash !== prev || rec.hash !== hashRecord({ ...rec, hash: undefined })) return false;
      prev = rec.hash;
    }
    return true;
  }
}

export class FileAuditLog extends MemoryAuditLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(filePath)) this.loadExisting();
  }

  private loadExisting(): void {
    try {
      const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as AuditRecord;
          this.records.push(rec);
          this.prevHash = rec.hash;
        } catch {
          this.prevHash = createHash("sha256").update(`${this.prevHash}:corrupt-line`).digest("hex");
        }
      }
    } catch {
      // unreadable prior log starts a fresh chain; chain break is visible via verify()
    }
  }

  override append(record: Omit<AuditRecord, "seq" | "prevHash" | "hash" | "ts">): AuditRecord {
    const full = super.append(record);
    appendFileSync(this.filePath, JSON.stringify(full) + "\n", { encoding: "utf8" });
    return full;
  }
}

const GenesisHash = "0".repeat(64);

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (val as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return val;
  });
}

function hashRecord(record: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(record)).digest("hex");
}

export function auditedInput(input: unknown): unknown {
  return redactDeep(input);
}
