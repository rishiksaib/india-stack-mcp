import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { AuditSink } from "../audit/fileAuditLog.js";
import type { CredentialVault } from "../auth/vault.js";
import { ErrorCode, ConnectorError, wrapUnknown } from "../errors.js";
import type { IdempotencyStore } from "../idempotency.js";
import { idempotencyKey } from "../idempotency.js";

export type ToolScope = "read" | "write";

export interface Approver {
  request(req: { tool: string; summary: unknown }): Promise<"allow" | "deny">;
}

export class AllowAllApprover implements Approver {
  async request(): Promise<"allow" | "deny"> {
    return "allow";
  }
}

export interface ToolContext {
  actor: string;
  connector: string;
  audit: AuditSink;
  idempotency: IdempotencyStore;
  vault: CredentialVault;
  approver: Approver;
}

export interface ToolOutput {
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ToolDefinition<S extends ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  scope: ToolScope;
  destructive?: boolean;
  inputSchema: S;
  handler: (
    args: z.objectOutputType<S, z.ZodTypeAny> & { dry_run?: boolean; idempotency_key?: string },
    ctx: ToolContext
  ) => Promise<ToolOutput>;
}

export type RunResult =
  | { ok: true; output: ToolOutput }
  | { ok: false; error: ReturnType<ConnectorError["toPayload"]> };

export interface RegisteredTool {
  readonly name: string;
  readonly scope: ToolScope;
  readonly destructive: boolean;
  run(args: unknown, ctx: ToolContext): Promise<RunResult>;
  attach(server: McpServer, ctx: ToolContext): void;
}

const DRY_RUN_DESCRIPTION = "Preview the exact upstream request without executing it. Defaults to true for all writes.";

export function defineTool<S extends ZodRawShape>(def: ToolDefinition<S>): RegisteredTool {
  const isWrite = def.scope === "write";

  const run = async (rawArgs: unknown, ctx: ToolContext): Promise<RunResult> => {
    const args = rawArgs as z.objectOutputType<S, z.ZodTypeAny> & { dry_run?: boolean; idempotency_key?: string };
    const started = Date.now();
    const dryRun = isWrite ? args.dry_run !== false : false;
    const action: "read" | "dry_run" | "execute" | "denied" | "error" = isWrite ? (dryRun ? "dry_run" : "execute") : "read";

    try {
      let key: string | undefined;
      if (isWrite && !dryRun) {
        key = args.idempotency_key ?? idempotencyKey(def.name, ctx.connector, args as Record<string, unknown>);
        const cached = await ctx.idempotency.get(key);
        if (cached) {
          ctx.audit.append({
            actor: ctx.actor,
            connector: ctx.connector,
            tool: def.name,
            action,
            status: "ok",
            durationMs: Date.now() - started,
            input: args,
            summary: { duplicate: true }
          });
          return {
            ok: true,
            output: {
              data: typeof cached.summary === "object" && cached.summary !== null ? { ...(cached.summary as Record<string, unknown>) } : { summary: cached.summary },
              meta: { duplicate: true, idempotencyKey: key }
            }
          };
        }
      }

      if (isWrite && !dryRun && def.destructive) {
        const decision = await ctx.approver.request({ tool: def.name, summary: args });
        if (decision === "deny") {
          ctx.audit.append({
            actor: ctx.actor,
            connector: ctx.connector,
            tool: def.name,
            action: "denied",
            status: "ok",
            durationMs: Date.now() - started,
            input: args
          });
          throw new ConnectorError(ErrorCode.ApprovalRequired, `Human approval denied for ${def.name}`);
        }
      }

      const output = await def.handler(args, ctx);

      if (key) await ctx.idempotency.put(key, output.data);
      ctx.audit.append({
        actor: ctx.actor,
        connector: ctx.connector,
        tool: def.name,
        action,
        status: "ok",
        durationMs: Date.now() - started,
        input: args,
        summary: output.meta?.preview ?? summarize(output.data)
      });

      return { ok: true, output };
    } catch (err) {
      const ce = wrapUnknown(err);
      ctx.audit.append({
        actor: ctx.actor,
        connector: ctx.connector,
        tool: def.name,
        action: "error",
        status: "error",
        durationMs: Date.now() - started,
        input: args,
        error: ce.toPayload()
      });
      return { ok: false, error: ce.toPayload() };
    }
  };

  const attach = (server: McpServer, ctx: ToolContext): void => {
    const shape: ZodRawShape = { ...def.inputSchema };
    if (isWrite) {
      shape.dry_run = z.boolean().optional().describe(DRY_RUN_DESCRIPTION);
      shape.idempotency_key = z.string().optional().describe("Optional client key so retried writes never double-post upstream.");
    }

    server.registerTool(
      def.name,
      {
        title: def.title ?? def.name,
        description: isWrite ? `${def.description} Writes default to dry-run preview; pass dry_run=false to commit.` : def.description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: !isWrite,
          destructiveHint: Boolean(def.destructive),
          openWorldHint: true
        }
      },
      async (toolArgs) => {
        const result = await run(toolArgs, ctx);
        if (result.ok) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, ...result.output }, null, 2) }]
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }, null, 2) }]
        };
      }
    );
  };

  return { name: def.name, scope: def.scope, destructive: Boolean(def.destructive), run, attach };
}

function summarize(data: Record<string, unknown>): unknown {
  const keys = Object.keys(data);
  const picked: Record<string, unknown> = {};
  for (const k of keys.slice(0, 12)) picked[k] = data[k];
  return picked;
}
