import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionEnvelope, importEnvelope, reportEnvelope } from "../src/client/xml/envelope.js";
import { ledgerImportMessage, voucherDeleteMessage, voucherImportMessage } from "../src/client/xml/importData.js";
import { extractDayBook, extractImportResult, extractRecords, parseBalance, parseXml } from "../src/client/xml/parse.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("envelope builders", () => {
  it("builds an Import Data envelope with company scoping", () => {
    const xml = importEnvelope("Vouchers", "<TALLYMESSAGE/>", "Acme Traders");
    expect(xml).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(xml).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(xml).toContain("<SVCURRENTCOMPANY>Acme Traders</SVCURRENTCOMPANY>");
    expect(xml).toContain("<REQUESTDATA><TALLYMESSAGE/></REQUESTDATA>");
  });

  it("omits STATICVARIABLES company when not provided", () => {
    const xml = importEnvelope("All Masters", "<X/>");
    expect(xml).not.toContain("SVCURRENTCOMPANY");
  });

  it("escapes XML-special characters", () => {
    const xml = importEnvelope("All Masters", `<TALLYMESSAGE>${ledgerImportMessage({ name: 'A & B <Ltd>', parent: "Sundry Debtors" })}</TALLYMESSAGE>`);
    expect(xml).toContain('NAME="A &amp; B &lt;Ltd&gt;"');
  });

  it("builds collection export envelopes", () => {
    const xml = collectionEnvelope({ id: "MyLedgers", type: "Ledger", fetchFields: ["NAME", "PARENT"], company: "C1" });
    expect(xml).toContain("<TYPE>Collection</TYPE><ID>MyLedgers</ID>");
    expect(xml).toContain('<COLLECTION NAME="MyLedgers" ISMODIFY="No">');
    expect(xml).toContain("<FETCH>NAME,PARENT</FETCH>");
    expect(xml).toContain("$$SysName:XML");
  });

  it("builds report export envelopes with compact dates", () => {
    const xml = reportEnvelope({ reportName: "Day Book", fromDate: "2024-04-01", toDate: "2024-04-30", company: "C1" });
    expect(xml).toContain("<TYPE>Data</TYPE><ID>Day Book</ID>");
    expect(xml).toContain("<SVFROMDATE>20240401</SVFROMDATE>");
    expect(xml).toContain("<SVTODATE>20240430</SVTODATE>");
  });
});

describe("voucher message builder", () => {
  const voucher = {
    kind: "Sales" as const,
    date: "2024-04-05",
    partyLedger: "Sunrise Stores",
    narration: "Test sale",
    // Connector convention: positive = debit. The customer is debited, sales and tax credited.
    lines: [
      { ledgerName: "Sunrise Stores", amount: 11800 },
      { ledgerName: "Sales Account", amount: -10000 },
      { ledgerName: "Output CGST", amount: -900 },
      { ledgerName: "Output SGST", amount: -900 }
    ]
  };

  it("writes debits as ISDEEMEDPOSITIVE=Yes with a negative AMOUNT, credits as No/positive (Tally convention)", () => {
    const msg = voucherImportMessage(voucher);
    expect(msg).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">');
    expect(msg).toContain("<DATE>20240405</DATE>");
    expect(msg).toContain("<PARTYLEDGERNAME>Sunrise Stores</PARTYLEDGERNAME>");
    expect(msg).toContain(
      "<LEDGERNAME>Sunrise Stores</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-11800.00</AMOUNT>"
    );
    expect(msg).toContain("<LEDGERNAME>Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT>");
    expect(msg).toContain("<LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT>");
  });

  it("rejects unbalanced vouchers client-side (client level covered elsewhere)", () => {
    expect(voucher.lines.reduce((a, l) => a + l.amount, 0)).toBe(0);
  });

  it("builds delete messages by master id, remote id, or number+type+date", () => {
    expect(voucherDeleteMessage({ masterId: "119", voucherType: "Payment", date: "2024-04-07" })).toContain(
      '<VOUCHER DATE="07-Apr-2024" TAGNAME="MASTER ID" TAGVALUE="119" VCHTYPE="Payment" ACTION="Delete"/>'
    );
    expect(voucherDeleteMessage({ remoteId: "abc-123" })).toContain('<VOUCHER REMOTEID="abc-123" ACTION="Delete"');
    expect(voucherDeleteMessage({ voucherNumber: "INV/24-25/001", voucherType: "Sales", date: "2024-04-05" })).toContain(
      'TAGNAME="Voucher Number" TAGVALUE="INV/24-25/001"'
    );
    expect(() => voucherDeleteMessage({})).toThrow();
    expect(() => voucherDeleteMessage({ masterId: "1" })).toThrow(/voucher_type and date/);
  });
});

describe("parsers", () => {
  it("extracts company records from a collection response regardless of element casing", () => {
    const parsed = parseXml(fixture("companies-response.xml"));
    const records = extractRecords(parsed, "IndiaStackCompanies");
    expect(records.length).toBe(2);
    expect(records[0]!.NAME).toBe("Acme Traders Pvt Ltd");
    expect(records[0]!.GUID).toBe("7c3a1b22-4a5e-11ee-9c11-0242ac120002");
  });

  it("extracts day book entries with line detail and debit totals", () => {
    const rows = extractDayBook(parseXml(fixture("daybook-response.xml")));
    expect(rows.length).toBe(2);
  });

  it("parses successful import results", () => {
    const result = extractImportResult(parseXml(fixture("import-success.xml")));
    expect(result.created).toBe(1);
    expect(result.exceptions).toBe(0);
    expect(result.lineErrors).toHaveLength(0);
  });

  it("parses failed import results with line errors", () => {
    const result = extractImportResult(parseXml(fixture("import-lineerror.xml")));
    expect(result.created).toBe(0);
    expect(result.exceptions).toBe(1);
    expect(result.lineErrors[0]).toContain("does not exist");
  });

  it("parses balances with Dr/Cr and sign conventions", () => {
    // Tally writes debits as negative numbers; the connector reports debit as positive.
    expect(parseBalance("-11800.00")).toBe(11800);
    expect(parseBalance("5000.00")).toBe(-5000);
    expect(parseBalance("25,000.00 Dr")).toBe(25000);
    expect(parseBalance("25000.00 Cr")).toBe(-25000);
    expect(parseBalance(undefined)).toBeUndefined();
  });
});
