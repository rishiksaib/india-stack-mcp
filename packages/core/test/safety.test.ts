import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ElicitationApprover,
  FileIdempotencyStore,
  MemoryAuditLog,
  MemoryIdempotencyStore,
  PolicyApprover,
  argsFingerprint,
  defineTool,
  isSensitiveKey,
  makeToolContext,
  redactDeep,
  redactString
} from "@india-stack/core";
import type { ToolContext } from "@india-stack/core";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { ...makeToolContext({ connector: "test", audit: new MemoryAuditLog() }), ...overrides };
}

function counterTool() {
  let calls = 0;
  const tool = defineTool({
    name: "post_entry",
    description: "posts",
    scope: "write",
    inputSchema: { lines: z.array(z.object({ ledger: z.string(), amount: z.number() })) },
    handler: async () => {
      calls += 1;
      return { data: { posted: calls } };
    }
  });
  return { tool, calls: () => calls };
}

describe("idempotency", () => {
  it("fingerprints nested arguments (different voucher lines => different fingerprints)", () => {
    const a = argsFingerprint("t", "c", { date: "2026-05-01", lines: [{ ledger: "Rent", amount: 100 }] });
    const b = argsFingerprint("t", "c", { date: "2026-05-01", lines: [{ ledger: "Salaries", amount: 98000 }] });
    expect(a).not.toBe(b);
    expect(argsFingerprint("t", "c", { x: 1, dry_run: false })).toBe(argsFingerprint("t", "c", { x: 1 }));
  });

  it("does not deduplicate identical writes when no idempotency_key is given", async () => {
    const { tool, calls } = counterTool();
    const context = ctx();
    const args = { lines: [{ ledger: "Cash", amount: 500 }], dry_run: false };
    await tool.run(args, context);
    await tool.run(args, context);
    expect(calls()).toBe(2);
  });

  it("returns the cached result for a retried key and refuses a key reused for different data", async () => {
    const { tool, calls } = counterTool();
    const context = ctx();
    const first = await tool.run({ lines: [{ ledger: "Rent", amount: 100 }], dry_run: false, idempotency_key: "k1" }, context);
    const retry = await tool.run({ lines: [{ ledger: "Rent", amount: 100 }], dry_run: false, idempotency_key: "k1" }, context);
    const reused = await tool.run({ lines: [{ ledger: "Salaries", amount: 98000 }], dry_run: false, idempotency_key: "k1" }, context);
    expect(calls()).toBe(1);
    expect(first.ok && retry.ok).toBe(true);
    if (retry.ok) expect(retry.output.meta?.duplicate).toBe(true);
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.message).toMatch(/already used for a different/);
  });

  it("keeps keys across restarts with the file store", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "isx-")), "keys.json");
    const s1 = new FileIdempotencyStore(file);
    await s1.put("k", { posted: 1 }, "fp");
    const s2 = new FileIdempotencyStore(file);
    expect(await s2.get("k")).toMatchObject({ summary: { posted: 1 }, fingerprint: "fp" });
  });

  it("expires entries after the TTL", async () => {
    const store = new MemoryIdempotencyStore(10);
    await store.put("k", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.get("k")).toBeNull();
  });
});

describe("redaction", () => {
  it("matches whole key words only", () => {
    expect(isSensitiveKey("company")).toBe(false);
    expect(isSensitiveKey("pan")).toBe(true);
    expect(isSensitiveKey("pan_number")).toBe(true);
    expect(isSensitiveKey("clientSecret")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("idempotency_key")).toBe(false);
    expect(redactDeep({ company: "Acme Traders Pvt Ltd" })).toEqual({ company: "Acme Traders Pvt Ltd" });
  });

  it("masks card and Aadhaar numbers but keeps record ids", () => {
    expect(redactString("card 4111 1111 1111 1111")).not.toContain("4111 1111 1111 1111");
    expect(redactString("aadhaar 234123412346")).not.toContain("234123412346");
    expect(redactString("invoice_id 460000000012345")).toContain("460000000012345");
  });
});

describe("approvals for destructive writes", () => {
  const destroy = defineTool({
    name: "destroy_entry",
    description: "d",
    scope: "write",
    destructive: true,
    inputSchema: { id: z.string() },
    handler: async () => ({ data: { destroyed: true } })
  });

  it("denies by default when no approver is wired", async () => {
    const result = await destroy.run({ id: "1", dry_run: false }, ctx({ approver: new PolicyApprover("deny") }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
  });

  async function connected(clientAnswers: "accept" | "decline" | "none") {
    const server = new McpServer({ name: "t", version: "1" });
    const context = ctx();
    context.approver = new ElicitationApprover(server, "ask");
    destroy.attach(server, context);
    const client = new Client(
      { name: "c", version: "1" },
      { capabilities: clientAnswers === "none" ? {} : { elicitation: {} } }
    );
    if (clientAnswers !== "none") {
      client.setRequestHandler(ElicitRequestSchema, async () =>
        clientAnswers === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" }
      );
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("asks the human through the client and proceeds on approval", async () => {
    const client = await connected("accept");
    const res = await client.callTool({ name: "destroy_entry", arguments: { id: "1", dry_run: false } });
    expect(res.isError).toBeFalsy();
  });

  it("stops when the human declines", async () => {
    const client = await connected("decline");
    const res = await client.callTool({ name: "destroy_entry", arguments: { id: "1", dry_run: false } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("did not approve");
  });

  it("refuses with instructions when the client cannot show a dialog", async () => {
    const client = await connected("none");
    const res = await client.callTool({ name: "destroy_entry", arguments: { id: "1", dry_run: false } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("INDIA_STACK_DESTRUCTIVE=allow");
  });
});
