import { compactDate, xmlEscape } from "./envelope.js";
import type { CreateLedgerInput, CreateVoucherInput } from "../types.js";

// Sign convention at this boundary:
//   connector input:  positive = debit, negative = credit (how accountants write it)
//   Tally XML:        debit  = ISDEEMEDPOSITIVE "Yes" with a NEGATIVE AMOUNT
//                     credit = ISDEEMEDPOSITIVE "No"  with a POSITIVE AMOUNT
// Source: Tally developer reference sample vouchers (e.g. Payment: expense Yes/-12000, bank No/12000).

export function toTallySign(debitPositiveAmount: number): number {
  const v = -toTallyAmount(debitPositiveAmount);
  return v === 0 ? 0 : v;
}

export function ledgerImportMessage(input: CreateLedgerInput): string {
  const opening = toTallySign(input.openingBalance ?? 0);
  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${xmlEscape(input.name)}" ACTION="Create">`,
    `<NAME.LIST><NAME>${xmlEscape(input.name)}</NAME></NAME.LIST>`,
    `<PARENT>${xmlEscape(input.parent)}</PARENT>`,
    `<OPENINGBALANCE>${opening.toFixed(2)}</OPENINGBALANCE>`,
    "</LEDGER>",
    "</TALLYMESSAGE>"
  ].join("");
}

export function voucherImportMessage(input: CreateVoucherInput): string {
  const date = compactDate(input.date);
  const party = input.partyLedger ? `<PARTYLEDGERNAME>${xmlEscape(input.partyLedger)}</PARTYLEDGERNAME>` : "";
  const narration = input.narration ? `<NARRATION>${xmlEscape(input.narration)}</NARRATION>` : "<NARRATION/>";
  const reference = input.reference ? `<REFERENCE>${xmlEscape(input.reference)}</REFERENCE>` : "";
  const partyName = input.partyLedger?.trim().toLowerCase();
  const entries = input.lines
    .map((line) => {
      const isDebit = line.amount > 0;
      const isParty = partyName !== undefined && line.ledgerName.trim().toLowerCase() === partyName;
      return [
        "<ALLLEDGERENTRIES.LIST>",
        `<LEDGERNAME>${xmlEscape(line.ledgerName)}</LEDGERNAME>`,
        `<ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
        isParty ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : "",
        `<AMOUNT>${toTallySign(line.amount).toFixed(2)}</AMOUNT>`,
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD -> dd-Mon-yyyy, the DATE attribute format Tally uses to address an existing voucher. */
export function tallyAttrDate(isoDate: string): string {
  const compact = compactDate(isoDate);
  const month = MONTHS[Number(compact.slice(4, 6)) - 1];
  if (!month) throw new Error(`invalid month in date "${isoDate}"`);
  return `${compact.slice(6, 8)}-${month}-${compact.slice(0, 4)}`;
}

/**
 * Delete an existing voucher. Preferred: Master ID (returned by create as masterId and by the
 * day book), addressed the way Tally's developer reference addresses vouchers for alteration:
 * DATE + TAGNAME="MASTER ID" + TAGVALUE + VCHTYPE.
 */
export function voucherDeleteMessage(opts: { masterId?: string; remoteId?: string; voucherNumber?: string; voucherType?: string; date?: string }): string {
  const wrap = (voucher: string) => ['<TALLYMESSAGE xmlns:UDF="TallyUDF">', voucher, "</TALLYMESSAGE>"].join("");
  if (opts.masterId) {
    if (!opts.voucherType || !opts.date) throw new Error("deleting by master_id also needs voucher_type and date");
    return wrap(
      `<VOUCHER DATE="${tallyAttrDate(opts.date)}" TAGNAME="MASTER ID" TAGVALUE="${xmlEscape(opts.masterId)}" VCHTYPE="${xmlEscape(opts.voucherType)}" ACTION="Delete"/>`
    );
  }
  if (opts.remoteId) {
    return wrap(`<VOUCHER REMOTEID="${xmlEscape(opts.remoteId)}" ACTION="Delete" OBJVIEW="Accounting Voucher View"/>`);
  }
  if (opts.voucherNumber && opts.voucherType && opts.date) {
    return wrap(
      `<VOUCHER DATE="${tallyAttrDate(opts.date)}" TAGNAME="Voucher Number" TAGVALUE="${xmlEscape(opts.voucherNumber)}" VCHTYPE="${xmlEscape(opts.voucherType)}" ACTION="Delete"/>`
    );
  }
  throw new Error("voucher deletion requires master_id (+ voucher_type, date), remote_id, or voucher_number + voucher_type + date");
}

export function toTallyAmount(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`non-finite amount: ${amount}`);
  return Number(amount.toFixed(2));
}
