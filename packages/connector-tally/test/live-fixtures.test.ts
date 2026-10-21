// Responses captured from a real TallyPrime 7.2 (Educational mode, company "India Stack Test")
// on 2026-10-21, while the connector posted, read back and deleted vouchers. See
// fixtures/live-tallyprime-7.2/README.md.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@india-stack/core";
import { TallyClient } from "../src/client/tallyClient.js";
import { extractDayBook, extractImportResult, extractRecords, parseXml } from "../src/client/xml/parse.js";

const live = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", "live-tallyprime-7.2", name), "utf8");

describe("real TallyPrime 7.2 responses", () => {
  it("import success: RESPONSE root, ERRORS=0, LASTVCHID is the new voucher's master id", () => {
    expect(extractImportResult(parseXml(live("import-voucher-created.xml")))).toMatchObject({ created: 1, errors: 0, exceptions: 0, lastVchId: "7", lineErrors: [] });
  });

  it("rejected voucher: LINEERROR with ERRORS=0 but EXCEPTIONS=1", () => {
    const r = extractImportResult(parseXml(live("import-voucher-lineerror.xml")));
    expect(r).toMatchObject({ created: 0, errors: 0, exceptions: 1 });
    expect(r.lineErrors).toEqual(["Ledger 'No Such Ledger' does not exist!"]);
  });

  it("delete: DELETED=1", () => {
    expect(extractImportResult(parseXml(live("import-voucher-deleted.xml")))).toMatchObject({ deleted: 1, errors: 0 });
  });

  it("ignores the CMPINFO count block (<VOUCHER>n</VOUCHER>, <LEDGER>n</LEDGER>)", () => {
    const vouchers = extractDayBook(parseXml(live("vouchers.xml")));
    expect(vouchers.length).toBeGreaterThan(0);
    expect(vouchers.every((v) => typeof v["@_REMOTEID"] === "string")).toBe(true);
    const ledgers = extractRecords(parseXml(live("ledgers.xml")), "IndiaStackLedgers", "Ledger");
    expect(ledgers.every((l) => typeof l.NAME === "string" && l.NAME !== "")).toBe(true);
  });
});

let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "text/xml");
      if (body.includes("<TYPE>Company</TYPE>")) return res.end(live("companies.xml"));
      if (body.includes("<TYPE>Ledger</TYPE>")) return res.end(live("ledgers.xml"));
      if (body.includes("<TYPE>Voucher</TYPE>")) return res.end(live("vouchers.xml"));
      if (body.includes("<TYPE>VoucherType</TYPE>")) return res.end(live("voucher-types.xml"));
      if (body.includes('ACTION="Delete"')) return res.end(live("import-voucher-deleted.xml"));
      if (body.includes("No Such Ledger")) return res.end(live("import-voucher-lineerror.xml"));
      if (body.includes("Import Data")) return res.end(live("import-voucher-created.xml"));
      res.end("<ENVELOPE></ENVELOPE>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (a && typeof a === "object") baseUrl = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("TallyClient replaying real TallyPrime 7.2 responses", () => {
  const client = () => new TallyClient({ baseUrl, company: "India Stack Test" });

  it("lists the company", async () => {
    expect(await client().listCompanies()).toEqual([
      { name: "India Stack Test", guid: "071edd80-6846-4442-a328-9eb76351279e", startingFrom: "20260401" }
    ]);
  });

  it("reads balances debit-positive and cleans the Primary parent", async () => {
    const byName = Object.fromEntries((await client().searchLedgers({})).map((l) => [l.name, l]));
    expect(byName["HDFC Bank"]).toMatchObject({ parent: "Bank Accounts", openingBalance: 100000 });
    expect(byName["Owner Capital"]).toMatchObject({ openingBalance: -100000 });
    expect(byName["Global Suppliers"]!.closingBalance).toBeLessThan(0);
    expect(byName["Profit & Loss A/c"]).toMatchObject({ parent: "Primary", reservedName: "Profit & Loss A/c" });
  });

  it("returns only real vouchers, with master id, reference and debit-positive lines", async () => {
    const vouchers = await client().dayBook({ from: "2026-04-01", to: "2026-05-31" });
    expect(vouchers.length).toBeGreaterThan(0);
    expect(vouchers.every((v) => v.voucherType && v.date && v.masterId)).toBe(true);
    const purchase = vouchers.find((v) => v.voucherType === "Purchase")!;
    expect(purchase).toMatchObject({ partyLedger: "Global Suppliers", reference: "GS/2026/114" });
    expect(purchase.lines).toEqual([
      { ledgerName: "Purchase Account", amount: 10000 },
      { ledgerName: "Input IGST", amount: 1800 },
      { ledgerName: "Global Suppliers", amount: -11800 }
    ]);
  });

  it("filters vouchers to the requested dates", async () => {
    const may = await client().dayBook({ from: "2026-05-01", to: "2026-05-31" });
    expect(may.every((v) => v.date! >= "20260501" && v.date! <= "20260531")).toBe(true);
  });

  it("reports a created voucher's master id and a rejected one's LINEERROR", async () => {
    const ok = await client().createVoucher(
      { kind: "Journal", date: "2026-05-02", lines: [{ ledgerName: "Rent", amount: 500 }, { ledgerName: "Owner Capital", amount: -500 }] },
      { dryRun: false }
    );
    expect(ok).toMatchObject({ created: 1, masterId: "7" });
    const err = await client()
      .createVoucher({ kind: "Journal", date: "2026-05-02", lines: [{ ledgerName: "No Such Ledger", amount: 1 }, { ledgerName: "Rent", amount: -1 }] }, { dryRun: false })
      .catch((e) => e);
    expect(err.code).toBe(ErrorCode.UpstreamRejected);
    expect(err.message).toBe("Ledger 'No Such Ledger' does not exist!");
  });

  it("confirms a delete", async () => {
    expect(await client().deleteVoucher({ masterId: "7", voucherType: "Journal", date: "2026-05-02" }, { dryRun: false })).toMatchObject({ deleted: 1 });
  });
});
