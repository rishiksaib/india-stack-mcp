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

export interface LedgerSummary {
  name: string;
  parent?: string;
  openingBalance?: number;
  closingBalance?: number;
}

export interface CreateLedgerInput {
  name: string;
  parent: string;
  openingBalance?: string;
}

export type VoucherKind =
  | "Sales"
  | "Purchase"
  | "Payment"
  | "Receipt"
  | "Journal"
  | "Credit Note"
  | "Debit Note";

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
  remoteId?: string;
  voucherNumber?: string;
  voucherType?: string;
  date?: string;
}

export interface DayBookEntry {
  date?: string;
  voucherType?: string;
  voucherNumber?: string;
  narration?: string;
  partyLedger?: string;
  amount?: number;
  lines?: Array<{ ledgerName?: string; amount?: number }>;
}

export interface ImportResult {
  created: number;
  altered: number;
  deleted: number;
  voucherDeleted: number;
  exceptions: number;
  lineErrors: string[];
}

export interface TallyClientLike {
  listCompanies(): Promise<TallyCompany[]>;
  getCompany(name: string): Promise<TallyCompany>;
  searchLedgers(opts: { query?: string; parent?: string }): Promise<LedgerSummary[]>;
  getLedger(name: string): Promise<LedgerSummary>;
  createLedger(input: CreateLedgerInput, opts: { dryRun: boolean }): Promise<{ preview: string } | ImportResult>;
  createVoucher(input: CreateVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<
    | { preview: string }
    | (ImportResult & { voucherNumber?: string })
  >;
  deleteVoucher(input: DeleteVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult>;
  ledgerBalances(opts: { parent?: string; company?: string }): Promise<LedgerSummary[]>;
  dayBook(opts: { from: string; to: string; company?: string }): Promise<DayBookEntry[]>;
  listVoucherTypes(opts: { company?: string }): Promise<string[]>;
}
