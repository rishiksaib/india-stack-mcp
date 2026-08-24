import { ErrorCode, ConnectorError } from "@india-stack/core";
import {
  collectionEnvelope,
  importEnvelope,
  reportEnvelope,
  type CollectionSpec
} from "./xml/envelope.js";
import { ledgerImportMessage, voucherDeleteMessage, voucherImportMessage } from "./xml/importData.js";
import { asArray, extractDayBook, extractImportResult, extractRecords, parseBalance, parseXml } from "./xml/parse.js";
import type {
  CreateLedgerInput,
  CreateVoucherInput,
  DayBookEntry,
  DeleteVoucherInput,
  ImportResult,
  LedgerSummary,
  TallyClientConfig,
  TallyCompany
} from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:9000";

export class TallyClient {
  private readonly baseUrl: string;
  private readonly defaultCompany?: string;
  private readonly timeoutMs: number;

  constructor(config: TallyClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.TALLY_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultCompany = config.company ?? process.env.TALLY_COMPANY;
    this.timeoutMs = config.timeoutMs ?? Number(process.env.TALLY_TIMEOUT_MS ?? 15000);
  }

  resolveCompany(company?: string): string | undefined {
    return company ?? this.defaultCompany;
  }

  async post(body: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "text/xml;charset=utf-8" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new ConnectorError(ErrorCode.UpstreamUnreachable, `Cannot reach Tally at ${this.baseUrl}: ${(err as Error).message}`, {
        detail: { baseUrl: this.baseUrl }
      });
    }
    if (!response.ok) {
      throw new ConnectorError(ErrorCode.UpstreamRejected, `Tally responded HTTP ${response.status}`, { detail: { status: response.status } });
    }
    const text = await response.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new ConnectorError(ErrorCode.AuthError, "Tally returned an HTML page; enable 'Serve XML requests' or check gateway security settings", {
        detail: { baseUrl: this.baseUrl }
      });
    }
    if (text.trim() === "") {
      throw new ConnectorError(ErrorCode.UpstreamRejected, "Tally returned an empty response");
    }
    return text;
  }

  async listCompanies(): Promise<TallyCompany[]> {
    const spec: CollectionSpec = { id: "IndiaStackCompanies", type: "Company", fetchFields: ["NAME", "GUID", "STARTINGFROM"] };
    const xml = await this.post(collectionEnvelope(spec));
    const records = extractRecords(parseXml(xml), spec.id);
    return records.map((r) => ({
      name: r["NAME"] ?? "",
      guid: r["GUID"],
      startingFrom: r["STARTINGFROM"]
    }));
  }

  async getCompany(name: string): Promise<TallyCompany> {
    const companies = await this.listCompanies();
    const match = companies.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      throw new ConnectorError(ErrorCode.NotFound, `Company "${name}" not found in Tally`, { detail: { available: companies.map((c) => c.name).slice(0, 20) } });
    }
    return match;
  }

  async searchLedgers(opts: { query?: string; parent?: string; company?: string }): Promise<LedgerSummary[]> {
    const spec: CollectionSpec = {
      id: "IndiaStackLedgers",
      type: "Ledger",
      fetchFields: ["NAME", "PARENT", "OPENINGBALANCE", "CLOSINGBALANCE"],
      company: this.resolveCompany(opts.company)
    };
    const xml = await this.post(collectionEnvelope(spec));
    const records = extractRecords(parseXml(xml), spec.id);
    let ledgers: LedgerSummary[] = records.map((r) => ({
      name: r["NAME"] ?? "",
      parent: r["PARENT"],
      openingBalance: parseBalance(r["OPENINGBALANCE"]),
      closingBalance: parseBalance(r["CLOSINGBALANCE"])
    }));
    if (opts.parent) {
      const p = opts.parent.toLowerCase();
      ledgers = ledgers.filter((l) => l.parent?.toLowerCase().includes(p));
    }
    if (opts.query) {
      const q = opts.query.toLowerCase();
      ledgers = ledgers.filter((l) => l.name.toLowerCase().includes(q));
    }
    return ledgers;
  }

  async getLedger(name: string, company?: string): Promise<LedgerSummary> {
    const ledgers = await this.searchLedgers({ company });
    const match = ledgers.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new ConnectorError(ErrorCode.NotFound, `Ledger "${name}" not found`);
    return match;
  }

  buildCreateLedgerRequest(input: CreateLedgerInput, company?: string): string {
    return importEnvelope("All Masters", ledgerImportMessage(input), this.resolveCompany(company));
  }

  async createLedger(input: CreateLedgerInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult> {
    const body = this.buildCreateLedgerRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    const result = assertImported(extractImportResult(parseXml(await this.post(body))));
    return result;
  }

  buildCreateVoucherRequest(input: CreateVoucherInput, company?: string): string {
    return importEnvelope("Vouchers", voucherImportMessage(input), this.resolveCompany(company));
  }

  async createVoucher(input: CreateVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | (ImportResult & { voucherNumber?: string })> {
    validateBalanced(input);
    const body = this.buildCreateVoucherRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    const result = assertImported(extractImportResult(parseXml(await this.post(body))));
    return { ...result, voucherNumber: extractCreatedVoucherNumber(result) };
  }

  buildDeleteVoucherRequest(input: DeleteVoucherInput, company?: string): string {
    const message = voucherDeleteMessage({ remoteId: input.remoteId, voucherNumber: input.voucherNumber, voucherType: input.voucherType, date: input.date });
    return importEnvelope("Vouchers", message, this.resolveCompany(company));
  }

  async deleteVoucher(input: DeleteVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult> {
    const body = this.buildDeleteVoucherRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    const result = assertImported(extractImportResult(parseXml(await this.post(body))));
    return result;
  }

  async ledgerBalances(opts: { parent?: string; company?: string }): Promise<LedgerSummary[]> {
    return this.searchLedgers(opts);
  }

  async dayBook(opts: { from: string; to: string; company?: string }): Promise<DayBookEntry[]> {
    const xml = await this.post(
      reportEnvelope({ reportName: "Day Book", fromDate: opts.from, toDate: opts.to, company: this.resolveCompany(opts.company) })
    );
    const rows = extractDayBook(parseXml(xml));
    return rows.map((row) => {
      const lines = asArray(row["ALLLEDGERENTRIES.LIST"]).map((raw) => {
        const entry = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        return {
          ledgerName: str(entry["LEDGERNAME"]),
          amount: parseBalance(entry["AMOUNT"])
        };
      });
      const amounts = lines.map((l) => l.amount ?? 0).filter((n) => n !== 0);
      const debit = amounts.filter((n) => n > 0).reduce((a, b) => a + b, 0);
      return {
        date: str(row["DATE"]),
        voucherType: str(row["VOUCHERTYPENAME"]),
        voucherNumber: str(row["VOUCHERNUMBER"]),
        narration: str(row["NARRATION"]) || undefined,
        partyLedger: str(row["PARTYLEDGERNAME"]) || undefined,
        amount: debit > 0 ? Math.round(debit * 100) / 100 : undefined,
        lines
      };
    });
  }

  async findVouchers(opts: { from: string; to: string; voucherType?: string; voucherNumber?: string; company?: string }): Promise<DayBookEntry[]> {
    let entries = await this.dayBook(opts);
    if (opts.voucherType) {
      const t = opts.voucherType.toLowerCase();
      entries = entries.filter((e) => e.voucherType?.toLowerCase() === t);
    }
    if (opts.voucherNumber) {
      const n = opts.voucherNumber.toLowerCase();
      entries = entries.filter((e) => e.voucherNumber?.toLowerCase().includes(n));
    }
    return entries;
  }

  async listVoucherTypes(company?: string): Promise<string[]> {
    const spec: CollectionSpec = {
      id: "IndiaStackVchTypes",
      type: "Vouchertype",
      fetchFields: ["NAME"],
      company: this.resolveCompany(company)
    };
    const xml = await this.post(collectionEnvelope(spec));
    const records = extractRecords(parseXml(xml), spec.id);
    return records.map((r) => r["NAME"] ?? "").filter(Boolean);
  }
}

function validateBalanced(input: CreateVoucherInput): void {
  if (!input.lines.length) throw new ConnectorError(ErrorCode.ValidationError, "voucher needs at least one line");
  const sum = Math.round(input.lines.reduce((acc, l) => acc + l.amount, 0) * 100) / 100;
  if (Math.abs(sum) > 0.004) {
    throw new ConnectorError(ErrorCode.ValidationError, `voucher is not balanced: debits minus credits = ${sum.toFixed(2)} (must be 0)`, {
      detail: { sum, lineCount: input.lines.length }
    });
  }
  for (const line of input.lines) {
    if (line.amount === 0) throw new ConnectorError(ErrorCode.ValidationError, `line "${line.ledgerName}" has amount 0`);
  }
}

function assertImported(raw: ReturnType<typeof extractImportResult>): ImportResult {
  const errors = [...raw.lineErrors, ...raw.errorsText];
  if (raw.exceptions > 0 || errors.length > 0 || (raw.created + raw.altered + raw.deleted + raw.voucherDeleted === 0)) {
    throw new ConnectorError(ErrorCode.UpstreamRejected, errors[0] ?? "Tally did not confirm the change", {
      detail: { created: raw.created, altered: raw.altered, deleted: raw.deleted, exceptions: raw.exceptions, lineErrors: errors.slice(0, 5) }
    });
  }
  return {
    created: raw.created,
    altered: raw.altered,
    deleted: raw.deleted,
    voucherDeleted: raw.voucherDeleted,
    exceptions: raw.exceptions,
    lineErrors: []
  };
}

function extractCreatedVoucherNumber(_result: ImportResult): string | undefined {
  return undefined;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
