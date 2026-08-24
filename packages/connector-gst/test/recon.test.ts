import { describe, expect, it } from "vitest";
import { normalizeInvoiceNumber, reconcile2b } from "../src/lib/recon.js";

const SUPPLIER_A = "27AAPFU0939F1ZV";
const SUPPLIER_B = "29AAACR5055K1Z3";

describe("invoice number normalization", () => {
  it("strips separators, case and leading zeros", () => {
    expect(normalizeInvoiceNumber("inv/24-25/001")).toBe("INV2425001");
    expect(normalizeInvoiceNumber("INV-0042")).toBe("INV0042");
    expect(normalizeInvoiceNumber("  abc_123 ")).toBe("ABC123");
    expect(normalizeInvoiceNumber(undefined)).toBe("");
    expect(normalizeInvoiceNumber("000012")).toBe("12");
  });
});

describe("GSTR-2B reconciliation", () => {
  it("matches identical invoices exactly", () => {
    const book = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-100", date: "2024-04-05", taxableValue: 10000, igst: 1800 }];
    const twoB = [{ gstin: SUPPLIER_A, invoiceNumber: "INV/100", invoiceDate: "2024-04-05", taxableValue: 10000, igst: 1800, itcAvailable: true }];
    const report = reconcile2b(book, twoB);
    expect(report.summary).toMatchObject({ matchedExact: 1, mismatches: 0, missingIn2b: 0, missingInBooks: 0 });
    expect(report.entries[0]!.status).toBe("matched_exact");
  });

  it("classifies supplier invoices absent from books as missing_in_books with ITC at risk", () => {
    const twoB = [
      { gstin: SUPPLIER_A, invoiceNumber: "INV-X", taxableValue: 5000, cgst: 450, sgst: 450 },
      { gstin: SUPPLIER_B, invoiceNumber: "INV-Y", taxableValue: 2000, igst: 360 }
    ];
    const report = reconcile2b([], twoB);
    expect(report.summary.missingInBooks).toBe(2);
    expect(report.summary.itcAtRisk).toBe(1260);
    expect(report.entries.every((e) => e.status === "missing_in_books")).toBe(true);
  });

  it("flags book purchases not in 2B as excess claim risk (supplier has not filed)", () => {
    const book = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-Z", taxableValue: 8000, igst: 1440 }];
    const report = reconcile2b(book, []);
    expect(report.summary.missingIn2b).toBe(1);
    expect(report.summary.excessClaimRisk).toBe(1440);
  });

  it("detects value and tax mismatches beyond tolerance with field diffs", () => {
    const book = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-M", taxableValue: 10500, igst: 1890 }];
    const twoB = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-M", taxableValue: 10000, igst: 1800 }];
    const report = reconcile2b(book, twoB);
    expect(report.summary.mismatches).toBe(1);
    expect(report.entries[0]!.diffs).toEqual([
      { field: "taxableValue", book: 10500, gstr2b: 10000, delta: 500 },
      { field: "tax", book: 1890, gstr2b: 1800, delta: 90 }
    ]);
  });

  it("tolerates sub-tolerance rounding differences without flagging mismatch", () => {
    const book = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-R", taxableValue: 10000.5, igst: 1800.9 }];
    const twoB = [{ gstin: SUPPLIER_A, invoiceNumber: "INV-R", taxableValue: 10000.25, igst: 1800.75 }];
    const report = reconcile2b(book, twoB, { valueTolerance: 1, taxTolerance: 1 });
    expect(report.summary.matchedExact).toBe(1);
    expect(report.summary.mismatches).toBe(0);
  });

  it("fuzzy-matches when the supplier renumbered the invoice but value/date align", () => {
    const book = [{ gstin: SUPPLIER_B, invoiceNumber: "OLD-9", date: "2024-04-10", taxableValue: 7000, igst: 1260 }];
    const twoB = [{ gstin: SUPPLIER_B, invoiceNumber: "NEW-77", invoiceDate: "2024-04-11", taxableValue: 7000, igst: 1260 }];
    const report = reconcile2b(book, twoB);
    expect(report.summary.matchedFuzzy).toBe(1);
    expect(report.entries[0]!.status).toBe("matched_fuzzy");
  });

  it("keeps duplicate book rows distinct when the same invoice appears twice in 2B", () => {
    const book = [
      { gstin: SUPPLIER_A, invoiceNumber: "DUP-1", taxableValue: 100, cgst: 9, sgst: 9 },
      { gstin: SUPPLIER_A, invoiceNumber: "DUP-1", taxableValue: 100, cgst: 9, sgst: 9 }
    ];
    const twoB = [
      { gstin: SUPPLIER_A, invoiceNumber: "DUP-1", taxableValue: 100, cgst: 9, sgst: 9 },
      { gstin: SUPPLIER_A, invoiceNumber: "DUP-1", taxableValue: 100, cgst: 9, sgst: 9 }
    ];
    const report = reconcile2b(book, twoB);
    expect(report.summary.matchedExact).toBe(2);
    expect(report.summary.missingIn2b).toBe(0);
  });

  it("does not fuzzy-match across different suppliers even for equal values", () => {
    const book = [{ gstin: SUPPLIER_B, invoiceNumber: "A-1", date: "2024-04-10", taxableValue: 7000, igst: 1260 }];
    const twoB = [{ gstin: SUPPLIER_A, invoiceNumber: "B-2", invoiceDate: "2024-04-10", taxableValue: 7000, igst: 1260 }];
    const report = reconcile2b(book, twoB);
    expect(report.summary.missingIn2b).toBe(1);
    expect(report.summary.missingInBooks).toBe(1);
    expect(report.summary.matchedFuzzy).toBe(0);
  });

  it("respects the date window for fuzzy matches", () => {
    const book = [{ gstin: SUPPLIER_A, invoiceNumber: "X-1", date: "2024-04-01", taxableValue: 900, igst: 162 }];
    const twoB = [{ gstin: SUPPLIER_A, invoiceNumber: "X-2", invoiceDate: "2024-04-28", taxableValue: 900, igst: 162 }];
    const report = reconcile2b(book, twoB, { dateWindowDays: 7 });
    expect(report.summary.matchedFuzzy).toBe(0);
    expect(report.summary.missingInBooks).toBe(1);
    expect(report.summary.missingIn2b).toBe(1);
  });
});
