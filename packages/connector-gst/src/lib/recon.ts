export interface PurchaseRow {
  gstin?: string;
  invoiceNumber?: string;
  date?: string;
  /** Negative for credit notes / debit notes that reduce ITC. */
  taxableValue: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
}

export interface Gstr2bRow {
  gstin?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  taxableValue: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  itcAvailable?: boolean;
  supplierFilingStatus?: string;
}

export interface ReconConfig {
  valueTolerance?: number;
  taxTolerance?: number;
  dateWindowDays?: number;
}

export type ReconStatus =
  | "matched_exact"
  | "matched_fuzzy"
  | "mismatch"
  | "missing_in_2b"
  | "missing_in_books";

export interface ReconDiff {
  field: "taxableValue" | "tax";
  book: number;
  gstr2b: number;
  delta: number;
}

export interface ReconEntry {
  status: ReconStatus;
  key: string;
  book?: PurchaseRow & { normalizedInvoice?: string };
  gstr2b?: Gstr2bRow & { normalizedInvoice?: string };
  diffs?: ReconDiff[];
  /** GSTR-2B marks this invoice's ITC as not available (e.g. Section 17(5), time-barred). */
  itcUnavailable?: boolean;
}

export interface ReconSummary {
  totalBookRows: number;
  total2bRows: number;
  matchedExact: number;
  matchedFuzzy: number;
  mismatches: number;
  missingIn2b: number;
  missingInBooks: number;
  /** Matched rows whose ITC GSTR-2B marks as not available. */
  itcUnavailable: number;
  /** Tax on invoices in 2B but not booked: ITC the business can claim once it books them. */
  itcAtRisk: number;
  /** Tax on booked invoices missing from 2B: not claimable until the supplier files. */
  excessClaimRisk: number;
  /** Tax on matched invoices that 2B marks as ITC not available. */
  ineligibleItc: number;
}

export interface ReconReport {
  summary: ReconSummary;
  entries: ReconEntry[];
  config: Required<ReconConfig>;
}

export function normalizeInvoiceNumber(input: string | undefined): string {
  if (!input) return "";
  return input.toUpperCase().replace(/[\s\-/\\._]/g, "").replace(/^0+(?=\d)/, "");
}

export function taxOf(row: { igst?: number; cgst?: number; sgst?: number; cess?: number }): number {
  return round2((row.igst ?? 0) + (row.cgst ?? 0) + (row.sgst ?? 0) + (row.cess ?? 0));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toDays(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
}

function diffRows(book: PurchaseRow, row2b: Gstr2bRow, cfg: Required<ReconConfig>): ReconDiff[] {
  const diffs: ReconDiff[] = [];
  const dv = round2(book.taxableValue - row2b.taxableValue);
  if (Math.abs(dv) > cfg.valueTolerance) {
    diffs.push({ field: "taxableValue", book: round2(book.taxableValue), gstr2b: round2(row2b.taxableValue), delta: dv });
  }
  const db = round2(taxOf(book) - taxOf(row2b));
  if (Math.abs(db) > cfg.taxTolerance) {
    diffs.push({ field: "tax", book: taxOf(book), gstr2b: taxOf(row2b), delta: db });
  }
  return diffs;
}

function entryKey(row: { gstin?: string; invoiceNumber?: string }): string {
  return `${(row.gstin ?? "?").toUpperCase()}|${normalizeInvoiceNumber(row.invoiceNumber) || "(no-number)"}`;
}

function exactKey(gstin: string | undefined, invoiceNumber: string | undefined): string | null {
  const norm = normalizeInvoiceNumber(invoiceNumber);
  if (!gstin?.trim() || !norm) return null;
  return `${gstin.trim().toUpperCase()}|${norm}`;
}

export function reconcile2b(purchases: PurchaseRow[], gstr2b: Gstr2bRow[], config: ReconConfig = {}): ReconReport {
  const cfg: Required<ReconConfig> = {
    valueTolerance: config.valueTolerance ?? 1,
    taxTolerance: config.taxTolerance ?? 1,
    dateWindowDays: config.dateWindowDays ?? 7
  };

  const usedBooks = new Set<number>();
  const entries: ReconEntry[] = [];

  const booksByExact = new Map<string, number[]>();
  for (const [i, p] of purchases.entries()) {
    const k = exactKey(p.gstin, p.invoiceNumber);
    if (k === null) continue;
    const list = booksByExact.get(k) ?? [];
    list.push(i);
    booksByExact.set(k, list);
  }

  for (const row of gstr2b) {
    let status: ReconStatus | null = null;
    let matchedBook: number | null = null;

    const key = exactKey(row.gstin, row.invoiceNumber);
    if (key !== null && booksByExact.has(key)) {
      const pick = booksByExact.get(key)!.find((i) => !usedBooks.has(i));
      if (pick !== undefined) {
        status = "matched_exact";
        matchedBook = pick;
      }
    }

    if (matchedBook === null) {
      const fuzzy = findFuzzyMatch(purchases, usedBooks, row, cfg);
      if (fuzzy !== null) {
        status = "matched_fuzzy";
        matchedBook = fuzzy;
      }
    }

    if (matchedBook === null) {
      entries.push({
        status: "missing_in_books",
        key: entryKey(row),
        gstr2b: { ...row, normalizedInvoice: normalizeInvoiceNumber(row.invoiceNumber) },
        ...(row.itcAvailable === false ? { itcUnavailable: true } : {})
      });
      continue;
    }

    usedBooks.add(matchedBook);
    const book = purchases[matchedBook]!;
    const diffs = diffRows(book, row, cfg);
    entries.push({
      status: diffs.length > 0 ? "mismatch" : (status ?? "matched_fuzzy"),
      key: entryKey(book),
      book: { ...book, normalizedInvoice: normalizeInvoiceNumber(book.invoiceNumber) },
      gstr2b: { ...row, normalizedInvoice: normalizeInvoiceNumber(row.invoiceNumber) },
      ...(diffs.length > 0 ? { diffs } : {}),
      ...(row.itcAvailable === false ? { itcUnavailable: true } : {})
    });
  }

  for (const [i, p] of purchases.entries()) {
    if (usedBooks.has(i)) continue;
    entries.push({
      status: "missing_in_2b",
      key: entryKey(p),
      book: { ...p, normalizedInvoice: normalizeInvoiceNumber(p.invoiceNumber) }
    });
  }

  let itcAtRisk = 0;
  let excessClaimRisk = 0;
  let ineligibleItc = 0;
  for (const e of entries) {
    if (e.status === "missing_in_books" && !e.itcUnavailable) itcAtRisk += taxOf(e.gstr2b!);
    if (e.status === "missing_in_2b") excessClaimRisk += taxOf(e.book!);
    if (e.itcUnavailable && e.book) ineligibleItc += taxOf(e.book);
  }

  return {
    config: cfg,
    summary: {
      totalBookRows: purchases.length,
      total2bRows: gstr2b.length,
      matchedExact: count(entries, "matched_exact"),
      matchedFuzzy: count(entries, "matched_fuzzy"),
      mismatches: count(entries, "mismatch"),
      missingIn2b: count(entries, "missing_in_2b"),
      missingInBooks: count(entries, "missing_in_books"),
      itcUnavailable: entries.filter((e) => e.itcUnavailable && e.book).length,
      itcAtRisk: round2(itcAtRisk),
      excessClaimRisk: round2(excessClaimRisk),
      ineligibleItc: round2(ineligibleItc)
    },
    entries
  };
}

function count(entries: ReconEntry[], status: ReconStatus): number {
  return entries.filter((e) => e.status === status).length;
}

function findFuzzyMatch(
  purchases: PurchaseRow[],
  usedBooks: Set<number>,
  row: Gstr2bRow,
  cfg: Required<ReconConfig>
): number | null {
  if (!row.gstin) return null;
  const rowDays = row.invoiceDate ? toDays(row.invoiceDate) : null;
  let best: { index: number; score: number } | null = null;

  for (const [i, p] of purchases.entries()) {
    if (usedBooks.has(i)) continue;
    if ((p.gstin ?? "").trim().toUpperCase() !== row.gstin.trim().toUpperCase()) continue;
    // A credit note never matches an invoice.
    if (Math.sign(p.taxableValue) !== Math.sign(row.taxableValue) && p.taxableValue !== 0 && row.taxableValue !== 0) continue;
    const dv = Math.abs(round2(p.taxableValue - row.taxableValue));
    if (dv > Math.max(cfg.valueTolerance * 10, 10)) continue;
    let score = dv + Math.abs(taxOf(p) - taxOf(row));
    const pDays = p.date ? toDays(p.date) : null;
    if (pDays !== null && rowDays !== null) {
      const dayGap = Math.abs(pDays - rowDays);
      if (dayGap > cfg.dateWindowDays) continue;
      score += dayGap * 0.1;
    }
    if (best === null || score < best.score) best = { index: i, score };
  }
  return best?.index ?? null;
}
