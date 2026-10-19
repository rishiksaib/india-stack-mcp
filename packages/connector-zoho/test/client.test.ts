import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorError, ErrorCode } from "@india-stack/core";
import { ZohoClient } from "../src/client/zohoClient.js";
import contactsFixture from "./fixtures/contacts.json";

let apiServer: Server;
let accountsServer: Server;
let apiUrl = "";
let accountsUrl = "";
const received: Array<{ method: string; path: string; body: unknown }> = [];

beforeAll(async () => {
  apiServer = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const pathname = url.pathname;
      const method = req.method ?? "";
      const parsedBody: unknown = data ? JSON.parse(data) : undefined;
      received.push({ method, path: `${pathname}${url.search}`, body: parsedBody });
      res.setHeader("Content-Type", "application/json");

      if (!String(req.headers.authorization ?? "").includes("at_ok")) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 57, message: "You are not authorized" }));
        return;
      }
      if (pathname === "/books/v3/contacts" && method === "GET") {
        res.end(JSON.stringify(contactsFixture));
        return;
      }
      if (pathname === "/books/v3/contacts" && method === "POST") {
        res.end(JSON.stringify({ code: 0, contact: { ...(parsedBody as Record<string, unknown>), contact_id: "460000000099" } }));
        return;
      }
      if (pathname === "/books/v3/invoices" && method === "POST") {
        if ((parsedBody as { customer_id?: string }).customer_id === "bad_customer") {
          res.writeHead(400);
          res.end(JSON.stringify({ code: 1032, message: "The customer does not exist." }));
          return;
        }
        res.end(
          JSON.stringify({
            code: 0,
            invoice: {
              invoice_id: "460000000123",
              invoice_number: "INV-00042",
              status: "draft",
              total: 1180,
              balance: 1180,
              customer_id: "460000000017",
              customer_name: "Sunrise Stores",
              line_items: [{ line_item_id: "li_1", name: "Widget", rate: 10, quantity: 100, item_total: 1000 }]
            }
          })
        );
        return;
      }
      if (pathname === "/books/v3/invoices/missing") {
        res.writeHead(404);
        res.end(JSON.stringify({ code: 1048, message: "This invoice does not exist." }));
        return;
      }
      if (pathname === "/books/v3/customerpayments" && method === "POST") {
        res.end(JSON.stringify({ code: 0, payment: { payment_id: "pay_1", amount: (parsedBody as { amount?: number }).amount } }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ code: 0, message: "ok" }));
    });
  });
  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

  accountsServer = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ access_token: "at_ok", expires_in: 3600, api_domain: apiUrl }));
  });
  await new Promise<void>((r) => accountsServer.listen(0, "127.0.0.1", r));
  accountsUrl = `http://127.0.0.1:${(accountsServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => accountsServer.close(() => r()));
});

function makeClient(): ZohoClient {
  return new ZohoClient({
    credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "good", dc: "in" },
    apiBaseOverride: apiUrl,
    accountsBaseOverride: accountsUrl,
    organizationId: "org_1"
  });
}

describe("ZohoClient against a stub gateway", () => {
  it("lists contacts with balances and pagination info", async () => {
    const result = await makeClient().listContacts({ type: "customer" });
    expect(result.records.length).toBe(2);
    expect(result.records[0]).toMatchObject({
      contactName: "Sunrise Stores",
      gstin: "27AAPFU0939F1ZV",
      outstandingReceivableAmount: 11800
    });
    expect(result.hasMore).toBe(false);
    expect(received.at(-1)?.path).toContain("organization_id=org_1");
  });

  it("dry-run returns the exact request body without POSTing", async () => {
    const result = await makeClient().createContact({ name: "New Party", type: "vendor", gstin: "29AAACR5055K1Z5" }, { dryRun: true });
    expect(result).toHaveProperty("preview");
    const preview = (result as { preview: Record<string, unknown> }).preview;
    expect(preview.contact_name).toBe("New Party");
    expect(preview.gst_no).toBe("29AAACR5055K1Z5");
    expect(preview.gst_treatment).toBe("business_gst");
    expect(preview.gstin).toBeUndefined();
    const postsBefore = received.filter((r) => r.path.startsWith("/books/v3/contacts") && r.method === "POST").length;
    expect(postsBefore).toBe(0);
  });

  it("creates a contact on execute and echoes the id", async () => {
    const created = await makeClient().createContact({ name: "New Party" }, { dryRun: false });
    expect(created).toMatchObject({ contactId: "460000000099" });
    expect(received.filter((r) => r.path.startsWith("/books/v3/contacts") && r.method === "POST")).toHaveLength(1);
  });

  it("rejects invoices with no line items client-side", () => {
    try {
      makeClient().buildCreateInvoiceBody({ customerId: "c1", lineItems: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConnectorError).code).toBe(ErrorCode.ValidationError);
    }
  });

  it("validates line items need item_id or name", () => {
    expect(() =>
      makeClient().buildCreateInvoiceBody({ customerId: "c1", lineItems: [{ rate: 10, quantity: 1 }] })
    ).toThrowError(/item_id or name/);
    expect(() =>
      makeClient().buildCreateInvoiceBody({ customerId: "c1", lineItems: [{ name: "X", rate: -1, quantity: 1 }] })
    ).not.toThrow();
  });

  it("creates an invoice and maps the response", async () => {
    const invoice = await makeClient().createInvoice(
      { customerId: "460000000017", lineItems: [{ itemId: "item_1", rate: 10, quantity: 118 }] },
      { dryRun: false }
    );
    expect(invoice).toMatchObject({ invoiceNumber: "INV-00042", status: "draft", total: 1180 });
    const post = received.find((r) => r.path.startsWith("/books/v3/invoices") && r.method === "POST");
    expect(post?.path).toContain("organization_id=org_1");
  });

  it("maps Zoho business errors to UpstreamRejected with the original message", async () => {
    const err = await makeClient()
      .createInvoice({ customerId: "bad_customer", lineItems: [{ name: "x", rate: 1, quantity: 1 }] }, { dryRun: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(ErrorCode.UpstreamRejected);
    expect(String((err as ConnectorError).detail?.zohoCode)).toBe("1032");
  });

  it("maps missing resources to NotFound", async () => {
    const err = await makeClient().getInvoice("missing").catch((e) => e);
    expect((err as ConnectorError).code).toBe(ErrorCode.NotFound);
  });

  it("builds customer payments with invoice application", () => {
    const body = makeClient().buildCustomerPaymentBody({ customerId: "c1", amount: 500, date: "2024-04-08", invoiceId: "inv_1" });
    expect(body.payment_mode).toBe("banktransfer");
    expect(body.invoices).toEqual([{ invoice_id: "inv_1", amount_applied: 500 }]);
    expect(() => makeClient().buildCustomerPaymentBody({ customerId: "c1", amount: 0, date: "2024-04-08" })).toThrow(/amount/);
    expect(() => makeClient().buildCustomerPaymentBody({ customerId: "c1", amount: 5, date: "08-04-2024" })).toThrow(/date/);
  });
});

const LIVE = Boolean(process.env.ZOHO_LIVE);
describe.skipIf(!LIVE)("live Zoho Books (set ZOHO_LIVE=1 + env creds)", () => {
  it("lists organizations", async () => {
    const orgs = await new ZohoClient({}).listOrganizations();
    console.log("organizations:", orgs.map((o) => `${o.name} (${o.organizationId})`));
    expect(Array.isArray(orgs)).toBe(true);
  });
});
