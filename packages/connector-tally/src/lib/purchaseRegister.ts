import type { DayBookEntry } from "../client/types.js";

export interface TaxLedgerNames {
  igst?: string[];
  cgst?: string[];
  sgst?: string[];
  cess?: string[];
}

/** One purchase invoice, shaped for gst_reconcile_2b's `purchases` input. */
export interface PurchaseRegisterRow {
  gstin?: string;
  invoice_number?: string;
  date?: string;
  supplier: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  voucher_number?: string;
  master_id?: string;
  /** Problems that make this row unreliable for reconciliation (missing GSTIN, missing bill no, ...). */
  warnings: string[];
}

const DEFAULT_PATTERNS: Record<keyof Required<TaxLedgerNames>, RegExp> = {
  igst: /\bigst\b|integrated\s+tax/i,
  cgst: /\bcgst\b|central\s+tax/i,
  sgst: /\bsgst\b|\butgst\b|state\s+tax|union\s+territory\s+tax/i,
  cess: /\bcess\b/i
};

function classify(ledger: string, names: TaxLedgerNames): keyof Required<TaxLedgerNames> | null {
  const l = ledger.trim().toLowerCase();
  for (const kind of ["igst", "cgst", "sgst", "cess"] as const) {
    const explicit = names[kind];
    if (explicit && explicit.length > 0) {
      if (explicit.some((n) => n.trim().toLowerCase() === l)) return kind;
    } else if (DEFAULT_PATTERNS[kind].test(ledger)) {
      return kind;
    }
  }
  return null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** YYYYMMDD (Tally) -> YYYY-MM-DD. */
function isoDate(d?: string): string | undefined {
  if (!d) return undefined;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return undefined;
}

/**
 * Build a purchase register from Purchase (and Debit Note) vouchers.
 * Input tax = debit lines on tax ledgers; taxable value = other debit lines excluding the
 * party; the supplier's bill number is the voucher's REFERENCE field.
 * Debit notes come out negative, which is how GSTR-2B shows them too.
 */
export function buildPurchaseRegister(
  vouchers: DayBookEntry[],
  ledgerGstins: Map<string, string>,
  taxLedgers: TaxLedgerNames = {},
  voucherTypes: string[] = ["Purchase", "Debit Note"]
): PurchaseRegisterRow[] {
  const wanted = new Set(voucherTypes.map((t) => t.toLowerCase()));
  const rows: PurchaseRegisterRow[] = [];
  for (const v of vouchers) {
    if (!v.voucherType || !wanted.has(v.voucherType.toLowerCase())) continue;
    const isReturn = v.voucherType.toLowerCase() === "debit note";
    const party = (v.partyLedger ?? "").trim().toLowerCase();
    const tax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    let taxable = 0;
    for (const line of v.lines ?? []) {
      const name = line.ledgerName ?? "";
      const amt = line.amount ?? 0;
      if (party && name.trim().toLowerCase() === party) continue;
      // Purchases debit expense and input tax (the supplier is the credit side); a debit note
      // reverses that. Only the expense/tax side is read, so a voucher with no party ledger set
      // still comes out right.
      if (isReturn ? amt >= 0 : amt <= 0) continue;
      const kind = classify(name, taxLedgers);
      const value = Math.abs(amt);
      if (kind) tax[kind] += value;
      else taxable += value;
    }
    const sign = isReturn ? -1 : 1;
    const gstin = v.partyGstin ?? ledgerGstins.get(party);
    const warnings: string[] = [];
    if (!gstin) warnings.push("no supplier GSTIN on the voucher or party ledger");
    if (!v.reference) warnings.push("no supplier bill number (Tally REFERENCE field is empty); matching will rely on GSTIN, value and date");
    if (taxable === 0) warnings.push("no taxable value found");
    rows.push({
      gstin,
      invoice_number: v.reference,
      date: isoDate(v.date),
      supplier: v.partyLedger ?? "",
      taxable_value: round2(sign * Math.abs(taxable)),
      igst: round2(sign * Math.abs(tax.igst)),
      cgst: round2(sign * Math.abs(tax.cgst)),
      sgst: round2(sign * Math.abs(tax.sgst)),
      cess: round2(sign * Math.abs(tax.cess)),
      voucher_number: v.voucherNumber,
      master_id: v.masterId,
      warnings
    });
  }
  return rows;
}
