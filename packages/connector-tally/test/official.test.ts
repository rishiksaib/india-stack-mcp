// Behaviour against response shapes documented in Tally's developer reference
// (help.tallysolutions.com: Case Study I and II, Integration - Transactions).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@india-stack/core";
import { TallyClient } from "../src/client/tallyClient.js";
import { extractDayBook, extractImportResult, extractRecords, parseXml } from "../src/client/xml/parse.js";
import { buildPurchaseRegister } from "../src/lib/purchaseRegister.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("documented response shapes", () => {
  it("reads ledger names from the NAME attribute under BODY/DATA/COLLECTION", () => {
    const records = extractRecords(parseXml(fixture("official-ledger-collection.xml")), "IndiaStackLedgers", "Ledger");
    expect(records.map((r) => r.NAME)).toEqual(["Rent", "HDFC Bank", "Capital Account", "Global Suppliers"]);
    expect(records[0]!.PARENT).toBe("Indirect Expenses");
    expect(records[3]!.PARTYGSTIN).toBe("27AAPFU0939F1ZV");
  });

  it("treats ERRORS=0 in a RESPONSE root as success and reads LASTMID", () => {
    const r = extractImportResult(parseXml(fixture("official-import-response.xml")));
    expect(r).toMatchObject({ created: 1, errors: 0, lineErrors: [], lastMasterId: "4567" });
  });

  it("reads counters and LASTVCHID from ENVELOPE/BODY/DATA/IMPORTRESULT", () => {
    const r = extractImportResult(parseXml(fixture("official-import-envelope.xml")));
    expect(r).toMatchObject({ created: 1, errors: 0, lastVchId: "119" });
  });

  it("reads LINEERROR text and the ERRORS count from a rejected import", () => {
    const r = extractImportResult(parseXml(fixture("official-import-error.xml")));
    expect(r.errors).toBe(1);
    expect(r.lineErrors[0]).toContain("Voucher totals do not match");
  });

  it("finds vouchers nested under TALLYMESSAGE with REMOTEID attributes", () => {
    const rows = extractDayBook(parseXml(fixture("official-daybook.xml")));
    expect(rows).toHaveLength(3);
    expect(rows[0]!["@_REMOTEID"]).toBe("e1d2-0001");
  });

  it("still accepts the legacy flat fixture shape", () => {
    const records = extractRecords(parseXml(fixture("companies-response.xml")), "IndiaStackCompanies", "Company");
    expect(records.map((r) => r.NAME)).toEqual(["Acme Traders Pvt Ltd", "Sunrise Retail"]);
  });
});

let server: Server;
let baseUrl = "";
const posts: string[] = [];
let importReply = fixture("official-import-envelope.xml");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push(body);
      res.setHeader("Content-Type", "text/xml");
      if (body.includes("Import Data")) return res.end(importReply);
      if (body.includes("<TYPE>Company</TYPE>")) return res.end(fixture("official-company-collection.xml"));
      if (body.includes("<TYPE>Ledger</TYPE>")) return res.end(fixture("official-ledger-collection.xml"));
      if (body.includes("<TYPE>Voucher</TYPE>")) return res.end(fixture("official-daybook.xml"));
      res.end("<ENVELOPE></ENVELOPE>");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TallyClient against documented responses", () => {
  it("lists companies", async () => {
    const companies = await new TallyClient({ baseUrl }).listCompanies();
    expect(companies).toEqual([{ name: "Acme Traders Pvt Ltd", guid: "7c3a1b22-4a5e", startingFrom: "20240401" }]);
  });

  it("reports balances with debit positive (Tally's -25000 is a debit)", async () => {
    const ledgers = await new TallyClient({ baseUrl }).searchLedgers({});
    const byName = Object.fromEntries(ledgers.map((l) => [l.name, l]));
    expect(byName["Rent"]!.closingBalance).toBe(25000);
    expect(byName["HDFC Bank"]!.closingBalance).toBe(75000);
    expect(byName["Capital Account"]!.closingBalance).toBe(-100000);
    expect(byName["Global Suppliers"]!.gstin).toBe("27AAPFU0939F1ZV");
  });

  it("reports a created voucher as success with its Master ID", async () => {
    importReply = fixture("official-import-envelope.xml");
    const result = await new TallyClient({ baseUrl }).createVoucher(
      { kind: "Payment", date: "2026-09-07", lines: [{ ledgerName: "Rent", amount: 25000 }, { ledgerName: "HDFC Bank", amount: -25000 }] },
      { dryRun: false }
    );
    expect(result).toMatchObject({ created: 1, masterId: "119" });
    expect(posts.at(-1)).toContain("<LEDGERNAME>Rent</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-25000.00</AMOUNT>");
  });

  it("treats a RESPONSE root with ERRORS=0 as success", async () => {
    importReply = fixture("official-import-response.xml");
    const result = await new TallyClient({ baseUrl }).createLedger({ name: "Suspense", parent: "Suspense A/c", openingBalance: 5000 }, { dryRun: false });
    expect(result).toMatchObject({ created: 1 });
    expect(posts.at(-1)).toContain("<OPENINGBALANCE>-5000.00</OPENINGBALANCE>");
  });

  it("surfaces LINEERROR as upstream_rejected", async () => {
    importReply = fixture("official-import-error.xml");
    const err = await new TallyClient({ baseUrl })
      .createVoucher({ kind: "Journal", date: "2026-09-07", lines: [{ ledgerName: "A", amount: 1 }, { ledgerName: "B", amount: -1 }] }, { dryRun: false })
      .catch((e) => e);
    expect(err.code).toBe(ErrorCode.UpstreamRejected);
    expect(err.message).toContain("Voucher totals do not match");
  });

  it("returns day-book vouchers with master id, remote id, reference and debit-positive lines", async () => {
    const entries = await new TallyClient({ baseUrl }).dayBook({ from: "2026-09-01", to: "2026-09-30" });
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ voucherType: "Payment", masterId: "302", remoteId: "e1d2-0002", amount: 25000 });
    expect(entries[1]!.lines).toEqual([
      { ledgerName: "Rent", amount: 25000 },
      { ledgerName: "HDFC Bank", amount: -25000 }
    ]);
    expect(entries[0]!.reference).toBe("GS/2026/114");
  });

  it("builds a purchase register ready for 2B reconciliation", async () => {
    const client = new TallyClient({ baseUrl });
    const [vouchers, ledgers] = await Promise.all([client.dayBook({ from: "2026-09-01", to: "2026-09-30" }), client.searchLedgers({})]);
    const gstins = new Map(ledgers.filter((l) => l.gstin).map((l) => [l.name.toLowerCase(), l.gstin!]));
    const rows = buildPurchaseRegister(vouchers, gstins);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      gstin: "27AAPFU0939F1ZV",
      invoice_number: "GS/2026/114",
      date: "2026-09-02",
      taxable_value: 10000,
      igst: 1800,
      cgst: 0,
      sgst: 0,
      master_id: "301",
      warnings: []
    });
    expect(rows[1]).toMatchObject({ invoice_number: "GS/2026/114-R", taxable_value: -1000, igst: -180 });
  });
});

describe("purchase register edge cases", () => {
  it("uses explicit tax ledger names and warns about missing GSTIN / bill number", () => {
    const rows = buildPurchaseRegister(
      [
        {
          voucherType: "Purchase",
          date: "20260905",
          lines: [
            { ledgerName: "Local Vendor", amount: -1120 },
            { ledgerName: "Stationery", amount: 1000 },
            { ledgerName: "Tax A", amount: 60 },
            { ledgerName: "Tax B", amount: 60 }
          ]
        }
      ],
      new Map(),
      { cgst: ["Tax A"], sgst: ["Tax B"] }
    );
    expect(rows[0]).toMatchObject({ taxable_value: 1000, cgst: 60, sgst: 60 });
    expect(rows[0]!.warnings.join(" ")).toMatch(/GSTIN/);
    expect(rows[0]!.warnings.join(" ")).toMatch(/bill number/);
  });
});
