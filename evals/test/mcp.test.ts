// Protocol-level tests: tools are called through a real MCP client, so argument parsing,
// defaults and snake_case -> camelCase mapping are exercised exactly as an agent hits them.
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAuditLog, makeToolContext } from "@india-stack/core";
import { createGstServer } from "@india-stack/connector-gst";
import { createTallyServer } from "@india-stack/connector-tally";
import { createZohoServer } from "@india-stack/connector-zoho";

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: "eval", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return { isError: Boolean(res.isError), body: JSON.parse(text) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } };
}

const party = (gstin: string, state: string) => ({ gstin, legal_name: "X", address: "1 Road", location: "City", pincode: "500001", state_code: state });

describe("gst server over MCP", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(createGstServer());
  });

  it("builds an e-invoice from the snake_case arguments agents send", async () => {
    const r = await call(client, "gst_einvoice_build", {
      document_number: "INV/1",
      document_date: "2026-10-01",
      seller: party("27AAPFU0939F1ZV", "27"),
      buyer: party("27AAPFU0939F1ZV", "27"),
      items: [{ hsn_code: "8471", quantity: 2, unit_price: 1000, tax_rate_percent: 18 }]
    });
    expect(r.isError).toBe(false);
    expect((r.body.data!.payload as { ValDtls: unknown }).ValDtls).toMatchObject({ CgstVal: 180, SgstVal: 180, TotInvVal: 2360 });
  });

  it("refuses live IRN generation instead of returning a fake IRN", async () => {
    const r = await call(client, "gst_einvoice_generate", {
      document_number: "INV/2",
      document_date: "2026-10-01",
      seller: party("27AAPFU0939F1ZV", "27"),
      buyer: party("27AAPFU0939F1ZV", "27"),
      items: [{ hsn_code: "8471", quantity: 1, unit_price: 100, tax_rate_percent: 18 }],
      dry_run: false
    });
    expect(r.isError).toBe(true);
    expect(r.body.error!.message).toMatch(/No IRP\/GSP client is configured/);
  });

  it("validates a GSTIN", async () => {
    const r = await call(client, "gst_validate_gstin", { gstin: "27AAPFU0939F1ZV" });
    expect(r.body.data).toMatchObject({ valid: true, state_code: "27" });
  });
});

describe("tally server over MCP", () => {
  let stub: Server;
  let url = "";
  const posts: string[] = [];
  let client: Client;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push(body);
        res.end(
          body.includes("Import Data")
            ? "<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>77</LASTVCHID></IMPORTRESULT></DATA></BODY></ENVELOPE>"
            : "<ENVELOPE></ENVELOPE>"
        );
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const addr = stub.address();
    if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}`;
    client = await connect(createTallyServer({ baseUrl: url }, makeToolContext({ connector: "tally", audit: new MemoryAuditLog() })));
  });

  afterAll(async () => {
    await new Promise<void>((r) => stub.close(() => r()));
  });

  it("previews by default and shows a debit/credit summary", async () => {
    const r = await call(client, "tally_create_voucher", {
      voucher_type: "Payment",
      date: "2026-09-07",
      lines: [{ ledger_name: "Rent", amount: 25000 }, { ledger_name: "HDFC Bank", amount: -25000 }]
    });
    expect(r.body.data).toMatchObject({ previewed: true, summary: { debit: [{ ledger: "Rent", amount: 25000 }], credit: [{ ledger: "HDFC Bank", amount: 25000 }] } });
    expect(posts.filter((p) => p.includes("Import Data"))).toHaveLength(0);
  });

  it("posts two different vouchers that share type, date and narration", async () => {
    const before = posts.length;
    const base = { voucher_type: "Journal", date: "2026-05-01", narration: "adj", dry_run: false };
    const a = await call(client, "tally_create_voucher", { ...base, lines: [{ ledger_name: "Rent", amount: 100 }, { ledger_name: "Capital", amount: -100 }] });
    const b = await call(client, "tally_create_voucher", { ...base, lines: [{ ledger_name: "Salaries", amount: 98000 }, { ledger_name: "HDFC Bank", amount: -98000 }] });
    expect(a.body.data).toMatchObject({ posted: true, master_id: "77" });
    expect(b.body.data).toMatchObject({ posted: true });
    expect(posts.length - before).toBe(2);
  });

  it("refuses to delete without human approval", async () => {
    const before = posts.length;
    const r = await call(client, "tally_delete_voucher", { master_id: "77", voucher_type: "Journal", date: "2026-05-01", dry_run: false });
    expect(r.isError).toBe(true);
    expect(r.body.error!.code).toBe("approval_required");
    expect(posts.length).toBe(before);
  });
});

describe("zoho server over MCP", () => {
  it("previews a GST-registered contact with Zoho's field names", async () => {
    const server = createZohoServer({ credentials: { clientId: "a", clientSecret: "b", refreshToken: "c", dc: "in" }, organizationId: "1" });
    const client = await connect(server);
    const r = await call(client, "zoho_create_contact", { name: "New Traders", gstin: " 27aapfu0939f1zv ", place_of_contact: "MH" });
    expect(r.body.data!.request).toEqual({
      contact_name: "New Traders",
      contact_type: "customer",
      gst_no: "27AAPFU0939F1ZV",
      gst_treatment: "business_gst",
      place_of_contact: "MH"
    });
  });

  it("previews a GST invoice with place of supply, tax_id and HSN", async () => {
    const server = createZohoServer({ credentials: { clientId: "a", clientSecret: "b", refreshToken: "c", dc: "in" }, organizationId: "1" });
    const client = await connect(server);
    const r = await call(client, "zoho_create_invoice", {
      customer_id: "c1",
      place_of_supply: "ka",
      line_items: [{ name: "Widget", rate: 1000, quantity: 1, tax_id: "tax-18", hsn_or_sac: "8471" }]
    });
    expect(r.body.data!.request).toMatchObject({
      place_of_supply: "KA",
      line_items: [{ name: "Widget", rate: 1000, quantity: 1, tax_id: "tax-18", hsn_or_sac: "8471" }]
    });
  });
});
