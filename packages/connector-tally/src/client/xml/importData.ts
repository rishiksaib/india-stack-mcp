import { compactDate, xmlEscape } from "./envelope.js";
import type { CreateLedgerInput, CreateVoucherInput } from "../types.js";

/**
 * Sign convention: the connector's public API is the accounting one — positive
 * = debit, negative = credit. Tally's XML is the reverse (a debit is written as
 * ISDEEMEDPOSITIVE=Yes with a NEGATIVE amount, per Tally's own import samples),
 * so amounts are negated here, at the XML boundary, and nowhere else.
 */
export function ledgerImportMessage(input: CreateLedgerInput): string {
  const ob = toTallyOpeningBalance(input.openingBalance);
  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${xmlEscape(input.name)}" Action="Create">`,
    `<PARENT>${xmlEscape(input.parent)}</PARENT>`,
    `<OPENINGBALANCE>${xmlEscape(ob)}</OPENINGBALANCE>`,
    "</LEDGER>",
    "</TALLYMESSAGE>"
  ].join("");
}

export function voucherImportMessage(input: CreateVoucherInput): string {
  const date = compactDate(input.date);
  const party = input.partyLedger ? `<PARTYLEDGERNAME>${xmlEscape(input.partyLedger)}</PARTYLEDGERNAME>` : "";
  const narration = input.narration ? `<NARRATION>${xmlEscape(input.narration)}</NARRATION>` : "<NARRATION/>";
  const reference = input.reference ? `<REFERENCE>${xmlEscape(input.reference)}</REFERENCE>` : "";
  const entries = input.lines
    .map((line) => {
      const amount = toTallyAmount(-line.amount);
      const deemedPositive = line.amount > 0 ? "Yes" : "No";
      return [
        "<ALLLEDGERENTRIES.LIST>",
        `<LEDGERNAME>${xmlEscape(line.ledgerName)}</LEDGERNAME>`,
        `<ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>`,
        `<AMOUNT>${amount.toFixed(2)}</AMOUNT>`,
        "</ALLLEDGERENTRIES.LIST>"
      ].join("");
    })
    .join("");
  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<VOUCHER VCHTYPE="${xmlEscape(input.kind)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${date}</DATE>`,
    `<EFFECTIVEDATE>${date}</EFFECTIVEDATE>`,
    reference,
    narration,
    `<VOUCHERTYPENAME>${xmlEscape(input.kind)}</VOUCHERTYPENAME>`,
    party,
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>",
    entries,
    "</VOUCHER>",
    "</TALLYMESSAGE>"
  ].join("");
}

export function voucherDeleteMessage(opts: { remoteId?: string; voucherNumber?: string; voucherType?: string; date?: string }): string {
  if (opts.remoteId) {
    return [
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
      `<VOUCHER REMOTEID="${xmlEscape(opts.remoteId)}" ACTION="Delete" OBJVIEW="Accounting Voucher View"/>`,
      "</TALLYMESSAGE>"
    ].join("");
  }
  if (opts.voucherNumber && opts.voucherType && opts.date) {
    const date = compactDate(opts.date);
    return [
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
      `<VOUCHER VCHTYPE="${xmlEscape(opts.voucherType)}" ACTION="Delete" OBJVIEW="Accounting Voucher View">`,
      `<DATE>${date}</DATE>`,
      `<VOUCHERNUMBER>${xmlEscape(opts.voucherNumber)}</VOUCHERNUMBER>`,
      "</VOUCHER>",
      "</TALLYMESSAGE>"
    ].join("");
  }
  throw new Error("voucher deletion requires remote_id, or voucher_type + voucher_number + date");
}

/** Opening balance in the public convention ("5000" = debit) → Tally XML ("-5000.00"). */
export function toTallyOpeningBalance(raw: string | undefined): string {
  const text = (raw ?? "").replace(/,/g, "").trim();
  if (text === "") return "0.00";
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`opening balance must be a number like "5000" or "-5000", got "${raw}"`);
  return value === 0 ? "0.00" : (-value).toFixed(2);
}

export function toTallyAmount(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`non-finite amount: ${amount}`);
  return Number(amount.toFixed(2));
}
