import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Approver } from "./defineTool.js";

export type DestructivePolicy = "ask" | "allow" | "deny";

export interface ApprovalRequest {
  tool: string;
  summary: unknown;
}

export interface ApprovalDecision {
  decision: "allow" | "deny";
  reason: string;
}

/** Reads INDIA_STACK_DESTRUCTIVE: "ask" (default), "allow" or "deny". */
export function destructivePolicyFromEnv(): DestructivePolicy {
  const raw = (process.env.INDIA_STACK_DESTRUCTIVE ?? "ask").toLowerCase();
  return raw === "allow" || raw === "deny" ? raw : "ask";
}

/** Fixed policy: allow everything or deny everything. */
export class PolicyApprover implements Approver {
  lastReason = "";
  constructor(private readonly policy: "allow" | "deny") {}

  async request(): Promise<"allow" | "deny"> {
    this.lastReason =
      this.policy === "allow"
        ? "INDIA_STACK_DESTRUCTIVE=allow"
        : "Destructive actions are disabled (INDIA_STACK_DESTRUCTIVE=deny).";
    return this.policy;
  }
}

/**
 * Asks the human through MCP elicitation (a confirmation dialog in the client) before any
 * destructive write. If the client cannot show elicitation dialogs, falls back to
 * INDIA_STACK_DESTRUCTIVE: "allow" lets it through, anything else denies with instructions.
 */
export class ElicitationApprover implements Approver {
  lastReason = "";

  constructor(
    private readonly server: McpServer,
    private readonly policy: DestructivePolicy = destructivePolicyFromEnv()
  ) {}

  async request(req: ApprovalRequest): Promise<"allow" | "deny"> {
    if (this.policy === "allow") {
      this.lastReason = "INDIA_STACK_DESTRUCTIVE=allow";
      return "allow";
    }
    if (this.policy === "deny") {
      this.lastReason = "Destructive actions are disabled (INDIA_STACK_DESTRUCTIVE=deny).";
      return "deny";
    }
    const supportsElicitation = Boolean(this.server.server.getClientCapabilities()?.elicitation);
    if (!supportsElicitation) {
      this.lastReason =
        "This MCP client cannot show an approval dialog. Make the change in the accounting system yourself, or set INDIA_STACK_DESTRUCTIVE=allow in this server's config to permit destructive actions without a dialog.";
      return "deny";
    }
    try {
      const result = await this.server.server.elicitInput({
        message: `Approve destructive action "${req.tool}"?\n\n${JSON.stringify(req.summary, null, 2)}`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve", description: "Tick to allow this change. It cannot be undone." }
          },
          required: ["approve"]
        }
      });
      const approved = result.action === "accept" && (result.content as Record<string, unknown> | undefined)?.approve === true;
      this.lastReason = approved ? "Approved by the user in the client dialog." : "The user did not approve the action.";
      return approved ? "allow" : "deny";
    } catch (err) {
      this.lastReason = `Approval dialog failed: ${(err as Error).message}`;
      return "deny";
    }
  }
}
