import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConnectorError,
  ErrorCode,
  MemoryAuditLog,
  MemoryIdempotencyStore,
  defineTool,
  makeToolContext,
  redactDeep,
  redactString
} from "@india-stack/core";
import type { ToolContext } from "@india-stack/core";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { ...makeToolContext({ connector: "test", audit: new MemoryAuditLog() }), ...overrides };
}

describe("audit chain", () => {
  it("chains hashes and verifies untampered logs", () => {
    const log = new MemoryAuditLog();
    log.append({ actor: "a", connector: "c", tool: "t", action: "read", status: "ok" });
    log.append({ actor: "a", connector: "c", tool: "u", action: "read", status: "ok" });
    log.append({ actor: "b", connector: "c", tool: "v", action: "read", status: "ok" });
    expect(log.records.length).toBe(3);
    expect(log.verify()).toBe(true);
    expect(log.records[2]!.prevHash).toBe(log.records[1]!.hash);
  });

  it("detects tampering", () => {
    const log = new MemoryAuditLog();
    log.append({ actor: "a", connector: "c", tool: "t", action: "read" });
    log.append({ actor: "a", connector: "c", tool: "u", action: "read" });
    (log.records as unknown as Array<Record<string, unknown>>)[0]!.tool = "forged";
    expect(log.verify()).toBe(false);
  });

  it("redacts sensitive inputs before hashing them in", () => {
    const log = new MemoryAuditLog();
    const rec = log.append({
      actor: "a",
      connector: "c",
      tool: "t",
      action: "read",
      input: { token: "abc123", note: "PAN ABCDE1234F on invoice", nested: { password: "hunter2" } }
    });
    const input = rec.input as Record<string, unknown>;
    expect(input.token).toBe("[redacted]");
    expect(input.nested).toEqual({ password: "[redacted]" });
    expect(String(input.note)).not.toContain("ABCDE1234F");
  });
});

describe("redaction", () => {
  it("masks PAN, GSTIN and PAN-like strings inside text", () => {
    const out = redactString("customer pan ABCDE1234F gstin 27AAPFU0939F1ZV card 4111111111111111");
    expect(out).not.toContain("ABCDE1234F");
    expect(out).not.toContain("27AAPFU0939F1ZV");
    expect(out).not.toContain("4111111111111111");
  });

  it("keeps ordinary text intact", () => {
    expect(redactDeep({ hello: "world", n: 5 })).toEqual({ hello: "world", n: 5 });
  });
});

describe("idempotency", () => {
  it("stores and expires entries", async () => {
    const store = new MemoryIdempotencyStore(10);
    await store.put("k", { x: 1 });
    expect((await store.get("k"))?.summary).toEqual({ x: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.get("k")).toBeNull();
  });
});

describe("defineTool", () => {
  const echoWrite = defineTool({
    name: "test_write",
    description: "writes a thing",
    scope: "write",
    inputSchema: { value: z.string() },
    handler: async (args) => ({ data: { wrote: args.value } })
  });

  it("write tools default to dry-run and audit the action as dry_run", async () => {
    let upstreamCalls = 0;
    const tool = defineTool({
      name: "w",
      description: "w",
      scope: "write",
      inputSchema: { value: z.string() },
      handler: async (args) => {
        if (args.dry_run !== false) return { data: { previewed: true }, meta: { preview: true } };
        upstreamCalls += 1;
        return { data: {} };
      }
    });
    const context = ctx();
    const result = await tool.run({ value: "x" }, context);
    expect(result.ok).toBe(true);
    expect(upstreamCalls).toBe(0);
    expect(context.audit.records[0]!.action).toBe("dry_run");
  });

  it("executes when dry_run=false and caches by idempotency key", async () => {
    let calls = 0;
    const tool = defineTool({
      name: "w2",
      description: "w2",
      scope: "write",
      inputSchema: { value: z.string() },
      handler: async (args) => {
        calls += 1;
        return { data: { wrote: args.value, call: calls } };
      }
    });
    const context = ctx();
    const first = await tool.run({ value: "x", dry_run: false, idempotency_key: "same" }, context);
    const second = await tool.run({ value: "x", dry_run: false, idempotency_key: "same" }, context);
    expect(first.ok && second.ok).toBe(true);
    expect(calls).toBe(1);
    if (first.ok) expect(first.output.meta?.duplicate).toBeUndefined();
    if (second.ok) expect(second.output.meta?.duplicate).toBe(true);
  });

  it("maps handler errors into structured payloads and audits them", async () => {
    const failing = defineTool({
      name: "failing_read",
      description: "f",
      scope: "read",
      inputSchema: {},
      handler: async () => {
        throw new ConnectorError(ErrorCode.UpstreamUnreachable, "cannot reach");
      }
    });
    const context = ctx();
    const result = await failing.run({}, context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.UpstreamUnreachable);
      expect(result.error.retryable).toBe(true);
    }
    expect(context.audit.records[0]!.action).toBe("error");
    expect(context.audit.records[0]!.status).toBe("error");
  });

  it("blocks destructive writes when approver denies", async () => {
    const destructive = defineTool({
      name: "destroy",
      description: "d",
      scope: "write",
      destructive: true,
      inputSchema: { id: z.string() },
      handler: async () => ({ data: { destroyed: true } })
    });
    const context = ctx({
      approver: { request: async () => "deny" }
    });
    const result = await destructive.run({ id: "1", dry_run: false }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.ApprovalRequired);
    expect(context.audit.records[0]!.action).toBe("denied");
  });

  it("echo write tool exposes correct shape via run()", async () => {
    const result = await echoWrite.run({ value: "hi", dry_run: false }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.data.wrote).toBe("hi");
  });
});
