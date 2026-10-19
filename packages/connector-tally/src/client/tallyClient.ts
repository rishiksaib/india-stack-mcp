import { ErrorCode, ConnectorError } from "@india-stack/core";
import {
  collectionEnvelope,
  importEnvelope,
  reportEnvelope,
  type CollectionSpec
} from "./xml/envelope.js";
import { ledgerImportMessage, voucherDeleteMessage, voucherImportMessage } from "./xml/importData.js";
import {
  asArray,
  extractDayBook,
  extractImportResult,
  extractRecords,
  findElements,
  isRecord,
  parseBalance,
  parseXml,
  textOf,
  type RawImportResult
} from "./xml/parse.js";
import type {
  CreateLedgerInput,
  CreateVoucherInput,
  DayBookEntry,
  DeleteVoucherInput,
  ImportResult,
  LedgerSummary,
  TallyClientConfig,
  TallyClientLike,
  TallyCompany
} from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:9000";

export class TallyClient implements TallyClientLike {
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
      const e = err as Error & { cause?: { code?: string } };
      const timedOut = e.name === "TimeoutError" || /timeout|aborted/i.test(e.message);
      throw new ConnectorError(
        ErrorCode.UpstreamUnreachable,
        timedOut
          ? `Tally at ${this.baseUrl} did not answer within ${this.timeoutMs} ms (timeout)`
          : `Cannot reach Tally at ${this.baseUrl}: ${e.cause?.code ?? e.message}. Is TallyPrime open with its XML server enabled?`,
        { detail: { baseUrl: this.baseUrl } }
      );
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
      throw new ConnectorError(ErrorCode.UpstreamRejected, "Tally returned an empty response (usually a company that is not loaded, or a security setting blocking the request)");
    }
    return text;
  }

  async listCompanies(): Promise<TallyCompany[]> {
    const spec: CollectionSpec = { id: "IndiaStackCompanies", type: "Company", fetchFields: ["NAME", "GUID", "STARTINGFROM"] };
    const xml = await this.post(collectionEnvelope(spec));
    const records = extractRecords(parseXml(xml), spec.id, "Company");
    return records
      .map((r) => ({ name: r["NAME"] ?? "", guid: r["GUID"], startingFrom: r["STARTINGFROM"] }))
      .filter((c) => c.name !== "");
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
      fetchFields: ["NAME", "PARENT", "OPENINGBALANCE", "CLOSINGBALANCE", "PARTYGSTIN", "LEDGSTREGDETAILS"],
      company: this.resolveCompany(opts.company)
    };
    const parsed = parseXml(await this.post(collectionEnvelope(spec)));
    const raw = findElements(parsed, (tag) => tag.toUpperCase() === "LEDGER");
    const flat = extractRecords(parsed, spec.id, "Ledger");
    let ledgers: LedgerSummary[] = flat.map((r, i) => ({
      name: r["NAME"] ?? "",
      parent: r["PARENT"],
      openingBalance: parseBalance(r["OPENINGBALANCE"]),
      closingBalance: parseBalance(r["CLOSINGBALANCE"]),
      gstin: r["PARTYGSTIN"] || nestedGstin(raw[i])
    }));
    ledgers = ledgers.filter((l) => l.name !== "");
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
    if (!match) {
      const close = ledgers.filter((l) => l.name.toLowerCase().includes(name.toLowerCase().slice(0, 4))).map((l) => l.name).slice(0, 10);
      throw new ConnectorError(ErrorCode.NotFound, `Ledger "${name}" not found`, { detail: { similar: close } });
    }
    return match;
  }

  buildCreateLedgerRequest(input: CreateLedgerInput, company?: string): string {
    return importEnvelope("All Masters", ledgerImportMessage(input), this.resolveCompany(company));
  }

  async createLedger(input: CreateLedgerInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult> {
    const body = this.buildCreateLedgerRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    return assertImported(extractImportResult(parseXml(await this.post(body))));
  }

  buildCreateVoucherRequest(input: CreateVoucherInput, company?: string): string {
    validateBalanced(input);
    return importEnvelope("Vouchers", voucherImportMessage(input), this.resolveCompany(company));
  }

  async createVoucher(input: CreateVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | (ImportResult & { voucherNumber?: string })> {
    const body = this.buildCreateVoucherRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    return assertImported(extractImportResult(parseXml(await this.post(body))));
  }

  buildDeleteVoucherRequest(input: DeleteVoucherInput, company?: string): string {
    let message: string;
    try {
      message = voucherDeleteMessage(input);
    } catch (err) {
      throw new ConnectorError(ErrorCode.ValidationError, (err as Error).message);
    }
    return importEnvelope("Vouchers", message, this.resolveCompany(company));
  }

  async deleteVoucher(input: DeleteVoucherInput, opts: { dryRun: boolean; company?: string }): Promise<{ preview: string } | ImportResult> {
    const body = this.buildDeleteVoucherRequest(input, opts.company);
    if (opts.dryRun) return { preview: body };
    return assertImported(extractImportResult(parseXml(await this.post(body))));
  }

  async ledgerBalances(opts: { parent?: string; company?: string }): Promise<LedgerSummary[]> {
    return this.searchLedgers(opts);
  }

  async dayBook(opts: { from: string; to: string; company?: string }): Promise<DayBookEntry[]> {
    const xml = await this.post(
      reportEnvelope({ reportName: "Day Book", fromDate: opts.from, toDate: opts.to, company: this.resolveCompany(opts.company) })
    );
    return extractDayBook(parseXml(xml)).map(toDayBookEntry);
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
      type: "VoucherType",
      fetchFields: ["NAME", "PARENT"],
      company: this.resolveCompany(company)
    };
    const xml = await this.post(collectionEnvelope(spec));
    return extractRecords(parseXml(xml), spec.id, "VoucherType")
      .map((r) => r["NAME"] ?? "")
      .filter(Boolean);
  }
}

function toDayBookEntry(row: Record<string, unknown>): DayBookEntry {
  const rawLines = [...asArray(row["ALLLEDGERENTRIES.LIST"]), ...asArray(row["LEDGERENTRIES.LIST"])].filter(isRecord);
  const lines = rawLines.map((entry) => ({
    ledgerName: textOf(entry["LEDGERNAME"]) ?? "",
    amount: parseBalance(entry["AMOUNT"])
  }));
  const debit = lines.map((l) => l.amount ?? 0).filter((n) => n > 0).reduce((a, b) => a + b, 0);
  const attr = (name: string): string | undefined => {
    const v = row[`@_${name}`];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const text = (name: string): string | undefined => {
    const v = textOf(row[name]);
    return v === undefined || v === "" ? undefined : v;
  };
  return {
    date: text("DATE"),
    voucherType: text("VOUCHERTYPENAME") ?? attr("VCHTYPE"),
    voucherNumber: text("VOUCHERNUMBER"),
    narration: text("NARRATION"),
    partyLedger: text("PARTYLEDGERNAME"),
    partyGstin: text("PARTYGSTIN"),
    reference: text("REFERENCE"),
    masterId: text("MASTERID"),
    remoteId: attr("REMOTEID") ?? text("GUID"),
    amount: debit > 0 ? Math.round(debit * 100) / 100 : undefined,
    lines
  };
}

function nestedGstin(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const hit = findElements(raw, (tag) => tag.toUpperCase() === "GSTIN")[0];
  return hit ? textOf(hit) : undefined;
}

function validateBalanced(input: CreateVoucherInput): void {
  if (input.lines.length < 2) throw new ConnectorError(ErrorCode.ValidationError, "a voucher needs at least two lines (one debit, one credit)");
  const sum = Math.round(input.lines.reduce((acc, l) => acc + l.amount, 0) * 100) / 100;
  if (Math.abs(sum) > 0.004) {
    throw new ConnectorError(ErrorCode.ValidationError, `voucher is not balanced: debits minus credits = ${sum.toFixed(2)} (must be 0)`, {
      detail: { sum, lineCount: input.lines.length }
    });
  }
  for (const line of input.lines) {
    if (line.amount === 0) throw new ConnectorError(ErrorCode.ValidationError, `line "${line.ledgerName}" has amount 0`);
  }
  if (!input.lines.some((l) => l.amount > 0) || !input.lines.some((l) => l.amount < 0)) {
    throw new ConnectorError(ErrorCode.ValidationError, "a voucher needs at least one debit (positive) and one credit (negative) line");
  }
}

function assertImported(raw: RawImportResult): ImportResult {
  const changed = raw.created + raw.altered + raw.deleted + raw.voucherDeleted + raw.cancelled + raw.combined;
  if (raw.exceptions > 0 || raw.errors > 0 || raw.lineErrors.length > 0 || changed === 0) {
    throw new ConnectorError(ErrorCode.UpstreamRejected, raw.lineErrors[0] ?? "Tally did not confirm the change (nothing was created, altered or deleted)", {
      detail: {
        created: raw.created,
        altered: raw.altered,
        deleted: raw.deleted,
        errors: raw.errors,
        exceptions: raw.exceptions,
        ignored: raw.ignored,
        lineErrors: raw.lineErrors.slice(0, 5)
      }
    });
  }
  return {
    created: raw.created,
    altered: raw.altered,
    deleted: raw.deleted,
    voucherDeleted: raw.voucherDeleted,
    exceptions: raw.exceptions,
    lineErrors: [],
    masterId: raw.lastVchId ?? raw.lastMasterId
  };
}
