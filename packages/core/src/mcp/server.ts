import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino from "pino";
import { FileAuditLog, MemoryAuditLog, type AuditSink } from "../audit/fileAuditLog.js";
import { EnvVault } from "../auth/vault.js";
import { MemoryIdempotencyStore } from "../idempotency.js";
import { AllowAllApprover, type Approver, type ToolContext } from "./defineTool.js";

export function createLogger(_name = "india-stack") {
  return pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined }, process.env.INDIA_STACK_QUIET === "1" ? undefined : pino.destination({ dest: 2, sync: false }));
}

export interface ToolContextOptions {
  actor?: string;
  connector?: string;
  audit?: AuditSink;
  approver?: Approver;
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
    idempotency: new MemoryIdempotencyStore(),
    vault: new EnvVault(),
    approver: options.approver ?? new AllowAllApprover()
  };
}

export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
