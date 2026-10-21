export interface TallyClientConfig {
  baseUrl?: string;
  company?: string;
  timeoutMs?: number;
}

export interface TallyCompany {
  name: string;
  guid?: string;
  startingFrom?: string;
}

/** Balances use this connector's convention: positive = debit, negative = credit. */
export interface LedgerSummary {
  name: string;
  parent?: string;
  openingBalance?: number;
  closingBalance?: number;
  gstin?: string;
  /** Tally's reserved name for built-in ledgers, e.g. "Profit & Loss A/c". */
  reservedName?: string;
}

export interface CreateLedgerInput {
  name: string;
  parent: string;
  /** Positive = debit (e.g. bank, debtor), negative = credit (e.g. capital, creditor). */
  openingBalance?: number;
}

export type VoucherKind =
  | "Sales"
  | "Purchase"
  | "Payment"
  | "Receipt"
  | "Journal"
  | "Contra"
  | "Credit Note"
  | "Debit Note";

/** Positive amount = debit, negative = credit. */
export interface VoucherLine {
  ledgerName: string;
  amount: number;
}

export interface CreateVoucherInput {
  kind: VoucherKind;
  date: string;
  partyLedger?: string;
  narration?: string;
  lines: VoucherLine[];
  reference?: string;
}

export interface DeleteVoucherInput {
  masterId?: string;
  remoteId?: string;
  voucherNumber?: string;
  voucherType?: string;
  date?: string;
}

export interface DayBookLine {
  ledgerName?: string;
  /** Positive = debit, negative = credit. */
  amount?: number;
}

export interface DayBookEntry {
  date?: string;
  voucherType?: string;
  voucherNumber?: string;
  narration?: string;
  partyLedger?: string;
  partyGstin?: string;
  reference?: string;
  /** Tally Master ID: use with tally_delete_voucher. */
  masterId?: string;
  remoteId?: string;
  /** Total of the debit side. */
  amount?: number;
  lines?: DayBookLine[];
}

export interface ImportResult {
  created: number;
  altered: number;
  deleted: number;
  voucherDeleted: number;
  exceptions: number;
  lineErrors: string[];
  /** Master ID of the last voucher Tally created or changed (LASTVCHID). */
  masterId?: string;
}

export interface TallyClientLike {
  listCompanies(): Promise<TallyCompany[]>;
  getCompany(name: string): Promise<TallyCompany>;
  searchLedgers(opts: { query?: string; parent?: string; company?: string }): Promise<LedgerSummary[]>;
  getLedger(name: string, company?: string): Promise<LedgerSummary>;
  createLedger(input: CreateLedgerInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult>;
  createVoucher(input: CreateVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<
    | { preview: string }
    | (ImportResult & { voucherNumber?: string })
  >;
  deleteVoucher(input: DeleteVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult>;
  ledgerBalances(opts: { parent?: string; company?: string }): Promise<LedgerSummary[]>;
  dayBook(opts: { from: string; to: string; company?: string }): Promise<DayBookEntry[]>;
  findVouchers(opts: { from: string; to: string; voucherType?: string; voucherNumber?: string; company?: string }): Promise<DayBookEntry[]>;
  listVoucherTypes(company?: string): Promise<string[]>;
}
