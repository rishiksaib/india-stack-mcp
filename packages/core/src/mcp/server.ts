import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino from "pino";
import { FileAuditLog, MemoryAuditLog, type AuditSink } from "../audit/fileAuditLog.js";
import { EnvVault } from "../auth/vault.js";
import { FileIdempotencyStore, MemoryIdempotencyStore, type IdempotencyStore } from "../idempotency.js";
import { ElicitationApprover, PolicyApprover, destructivePolicyFromEnv } from "./approval.js";
import type { Approver, ToolContext } from "./defineTool.js";

export function createLogger(_name = "india-stack") {
  return pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined }, process.env.INDIA_STACK_QUIET === "1" ? undefined : pino.destination({ dest: 2, sync: false }));
}

export interface ToolContextOptions {
  actor?: string;
  connector?: string;
  audit?: AuditSink;
  approver?: Approver;
  idempotency?: IdempotencyStore;
}

function idempotencyFromEnv(auditPath: string | undefined): IdempotencyStore {
  const explicit = process.env.INDIA_STACK_IDEMPOTENCY_FILE;
  if (explicit && explicit !== ":memory:") return new FileIdempotencyStore(explicit);
  if (explicit === ":memory:") return new MemoryIdempotencyStore();
  // Default: keep idempotency keys next to the audit log so retries survive a restart.
  if (auditPath && auditPath !== ":memory:") return new FileIdempotencyStore(`${auditPath}.idempotency.json`);
  return new MemoryIdempotencyStore();
}

export function makeToolContext(options: ToolContextOptions = {}): ToolContext {
  const auditPath = process.env.INDIA_STACK_AUDIT_LOG;
  const audit: AuditSink =
    options.audit ??
    (auditPath && auditPath !== ":memory:" ? new FileAuditLog(auditPath) : new MemoryAuditLog());
  return {
    actor: options.actor ?? process.env.INDIA_STACK_ACTOR ?? "mcp-client",
    connector: options.connector ?? "unknown",
    audit,
    idempotency: options.idempotency ?? (options.audit ? new MemoryIdempotencyStore() : idempotencyFromEnv(auditPath)),
    vault: new EnvVault(),
    // Destructive writes are denied unless a human approves. Servers swap this for an
    // ElicitationApprover (useElicitationApprover) so the client can show a confirmation dialog.
    approver: options.approver ?? new PolicyApprover(destructivePolicyFromEnv() === "allow" ? "allow" : "deny")
  };
}

/** Route destructive-action approvals through the MCP client's confirmation dialog. */
export function useElicitationApprover(server: McpServer, ctx: ToolContext): ToolContext {
  ctx.approver = new ElicitationApprover(server);
  return ctx;
}

export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
