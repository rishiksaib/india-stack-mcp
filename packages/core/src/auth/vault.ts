import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Credential {
  kind: "none" | "basic" | "bearer" | "token" | "custom";
  username?: string;
  password?: string;
  token?: string;
  fields?: Record<string, string>;
}

export interface CredentialVault {
  get(ref: string): Promise<Credential | null>;
  set(ref: string, credential: Credential): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class EnvVault implements CredentialVault {
  constructor(private readonly prefix = "INDIA_STACK_") {}

  async get(ref: string): Promise<Credential | null> {
    const raw = process.env[this.prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Credential;
    } catch {
      return { kind: "token", token: raw };
    }
  }

  async set(): Promise<void> {
    throw new Error("EnvVault is read-only");
  }

  async delete(): Promise<void> {
    throw new Error("EnvVault is read-only");
  }
}

export class FileVault implements CredentialVault {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async get(ref: string): Promise<Credential | null> {
    const all = this.readAll();
    return all[ref] ?? null;
  }

  async set(ref: string, credential: Credential): Promise<void> {
    const all = this.readAll();
    all[ref] = credential;
    writeFileSync(this.filePath, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  async delete(ref: string): Promise<void> {
    const all = this.readAll();
    delete all[ref];
    writeFileSync(this.filePath, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private readAll(): Record<string, Credential> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }
}
