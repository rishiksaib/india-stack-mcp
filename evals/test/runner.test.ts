import { describe, expect, it } from "vitest";
import { makeToolContext, type RegisteredTool } from "@india-stack/core";
import {
  makeCompanyTools,
  makeLedgerTools,
  makeReportTools,
  makeVoucherTools,
  TallyClient
} from "@india-stack/connector-tally";
import type { DayBookEntry, ImportResult, LedgerSummary, TallyClientLike, TallyCompany } from "@india-stack/connector-tally";
import {
  makeContactTools,
  makeFinanceTools,
  makeInvoiceTools,
  makeItemTools,
  makeOrganizationTools
} from "@india-stack/connector-zoho";
import { makeEinvoiceTools, makeGstinTools, makeReconTools } from "@india-stack/connector-gst";
import type {
  CreateInvoiceInput,
  CreatePaymentInput,
  ZohoAccount,
  ZohoContact,
  ZohoInvoice,
  ZohoItem,
  ZohoOrganization
} from "@india-stack/connector-zoho";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCENARIOS_DIR = join(import.meta.dirname, "..", "scenarios");

interface Scenario {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  expect: { ok?: boolean; dataKeys?: string[]; errorContains?: string };
}

class MockTallyClient implements TallyClientLike {
  async listCompanies(): Promise<TallyCompany[]> {
    return [{ name: "Acme Traders Pvt Ltd", guid: "guid-1", startingFrom: "20230401" }];
  }

  async getCompany(name: string): Promise<TallyCompany> {
    if (name.toLowerCase() !== "acme traders pvt ltd") throw new Error(`company ${name} not found`);
    return (await this.listCompanies())[0]!;
  }

  async searchLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "Sunrise Stores", parent: "Sundry Debtors", closingBalance: -11800 },
      { name: "Sales Account", parent: "Sales Accounts", closingBalance: 250000 },
      { name: "HDFC Bank", parent: "Bank Accounts", closingBalance: 512340.55 }
    ];
  }

  async getLedger(name: string): Promise<LedgerSummary> {
    const all = await this.searchLedgers();
    const found = all.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`ledger ${name} not found`);
    return found;
  }

  async createLedger(_input: unknown, opts: { dryRun: boolean }): Promise<{ preview: string } | ImportResult> {
    return opts.dryRun ? { preview: "<ENVELOPE>...</ENVELOPE>" } : { created: 1, altered: 0, deleted: 0, voucherDeleted: 0, exceptions: 0, lineErrors: [] };
  }

  async createVoucher(
    _input: unknown,
    opts: { dryRun: boolean }
  ): Promise<{ preview: string } | (ImportResult & { voucherNumber?: string })> {
    return opts.dryRun ? { preview: "<ENVELOPE>...</ENVELOPE>" } : { created: 1, altered: 0, deleted: 0, voucherDeleted: 0, exceptions: 0, lineErrors: [] };
  }

  async deleteVoucher(_input: unknown, opts: { dryRun: boolean }): Promise<{ preview: string } | ImportResult> {
    return opts.dryRun ? { preview: "<ENVELOPE>...</ENVELOPE>" } : { created: 0, altered: 0, deleted: 1, voucherDeleted: 0, exceptions: 0, lineErrors: [] };
  }

  async ledgerBalances(opts: { parent?: string }): Promise<LedgerSummary[]> {
    const all = await this.searchLedgers();
    return opts.parent ? all.filter((l) => l.parent === opts.parent) : all;
  }

  async dayBook(): Promise<DayBookEntry[]> {
    return [
      {
        date: "20240405",
        voucherType: "Sales",
        voucherNumber: "INV/24-25/001",
        partyLedger: "Sunrise Stores",
        amount: 11800,
        lines: [
          { ledgerName: "Sunrise Stores", amount: -11800 },
          { ledgerName: "Sales Account", amount: 11800 }
        ]
      }
    ];
  }

  async listVoucherTypes(): Promise<string[]> {
    return ["Sales", "Purchase", "Payment", "Receipt", "Journal"];
  }
}

class MockZohoClient {
  async listOrganizations(): Promise<ZohoOrganization[]> {
    return [{ organizationId: "org_1", name: "Acme Traders Pvt Ltd", currencyCode: "INR", isActive: true }];
  }

  async listContacts(opts: { type?: string }): Promise<{ records: ZohoContact[]; hasMore: boolean; page: number }> {
    const contacts: ZohoContact[] = [
      { contactId: "c1", contactName: "Sunrise Stores", contactType: "customer", gstin: "27AAPFU0939F1ZV", outstandingReceivableAmount: 11800 },
      { contactId: "c2", contactName: "Global Suppliers", contactType: "vendor", outstandingPayableAmount: 45000 }
    ];
    return { records: opts.type ? contacts.filter((c) => c.contactType === opts.type) : contacts, hasMore: false, page: 1 };
  }

  async getContact(id: string): Promise<ZohoContact> {
    return (await this.listContacts()).records.find((c) => c.contactId === id) ?? { contactName: "" };
  }

  async createContact(input: { name: string }, opts: { dryRun: boolean }): Promise<{ preview: Record<string, unknown> } | ZohoContact> {
    return opts.dryRun ? { preview: { contact_name: input.name } } : { contactId: "c_new", contactName: input.name };
  }

  async listInvoices(): Promise<{ records: ZohoInvoice[]; hasMore: boolean; page: number }> {
    return {
      records: [{ invoiceId: "i1", invoiceNumber: "INV-00042", status: "sent", customerName: "Sunrise Stores", total: 11800, balance: 11800 }],
      hasMore: false,
      page: 1
    };
  }

  async getInvoice(id: string): Promise<ZohoInvoice> {
    return (await this.listInvoices()).records.find((i) => i.invoiceId === id) ?? {};
  }

  async createInvoice(input: CreateInvoiceInput, opts: { dryRun: boolean }): Promise<{ preview: Record<string, unknown> } | ZohoInvoice> {
    if (!input.lineItems.length) throw new Error("invoice needs at least one line item");
    return opts.dryRun ? { preview: { customer_id: input.customerId } } : { invoiceId: "i_new", invoiceNumber: "INV-00043", status: "draft" };
  }

  async listItems(): Promise<{ records: ZohoItem[]; hasMore: boolean; page: number }> {
    return { records: [{ itemId: "item_1", name: "Widget", rate: 10 }], hasMore: false, page: 1 };
  }

  async createItem(
    input: { name: string; rate: number },
    opts: { dryRun: boolean }
  ): Promise<{ preview: Record<string, unknown>; request?: Record<string, unknown> } | ZohoItem> {
    return opts.dryRun ? { preview: { name: input.name } } : { itemId: "item_new", name: input.name, rate: input.rate };
  }

  async chartOfAccounts(): Promise<{ records: ZohoAccount[]; hasMore: boolean; page: number }> {
    return { records: [{ accountId: "a1", accountName: "Sales Account", accountType: "income" }], hasMore: false, page: 1 };
  }

  async createCustomerPayment(
    input: CreatePaymentInput,
    opts: { dryRun: boolean }
  ): Promise<{ preview: Record<string, unknown> } | Record<string, unknown>> {
    if (!(input.amount > 0)) throw new Error("payment amount must be > 0");
    return opts.dryRun ? { preview: { amount: input.amount } } : { paymentId: "pay_new", amount: input.amount };
  }
}

function toolByName(name: string): RegisteredTool | undefined {
  const client: TallyClientLike = new MockTallyClient();
  const tallyTools = [
    ...makeCompanyTools(client as never),
    ...makeLedgerTools(client as never),
    ...makeVoucherTools(client as never),
    ...makeReportTools(client as never)
  ];
  const zohoClient = new MockZohoClient();
  const zohoTools = [
    ...makeOrganizationTools(zohoClient as never),
    ...makeContactTools(zohoClient as never),
    ...makeInvoiceTools(zohoClient as never),
    ...makeItemTools(zohoClient as never),
    ...makeFinanceTools(zohoClient as never)
  ];
  const gstTools = [...makeGstinTools(), ...makeEinvoiceTools(), ...makeReconTools()];
  return [...tallyTools, ...zohoTools, ...gstTools].find((t) => t.name === name);
}

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as Scenario);
}

describe("eval scenarios", () => {
  const scenarios = loadScenarios();

  it("has at least one scenario loaded", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const tool = toolByName(scenario.tool);
      expect(tool, `unknown tool ${scenario.tool}`).toBeDefined();
      const context = makeToolContext({ connector: "tally" });
      const result = await tool!.run(scenario.args, context);
      if (scenario.expect.ok === false) {
        expect(result.ok).toBe(false);
        if (!result.ok && scenario.expect.errorContains) {
          expect(JSON.stringify(result.error)).toContain(scenario.expect.errorContains);
        }
      } else {
        expect(result.ok).toBe(true);
        if (result.ok && scenario.expect.dataKeys) {
          for (const key of scenario.expect.dataKeys) {
            expect(Object.keys(result.output.data)).toContain(key);
          }
        }
      }
    });
  }

  it("offline client sanity: real TallyClient builds dry-run previews without network", () => {
    const client = new TallyClient({ baseUrl: "http://127.0.0.1:9" });
    const xml = client.buildCreateVoucherRequest({
      kind: "Payment",
      date: "2024-04-07",
      lines: [
        { ledgerName: "Rent", amount: 25000 },
        { ledgerName: "HDFC Bank", amount: -25000 }
      ]
    });
    expect(xml).toContain('<VOUCHER VCHTYPE="Payment" ACTION="Create"');
  });
});
