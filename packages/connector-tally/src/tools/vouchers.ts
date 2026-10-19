import { z } from "zod";
import { ConnectorError, ErrorCode, defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";
import type { CreateVoucherInput, DeleteVoucherInput, VoucherKind } from "../client/types.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export function assertBalanced(lines: Array<{ ledgerName: string; amount: number }>): void {
  if (lines.length < 2) throw new ConnectorError(ErrorCode.ValidationError, "a voucher needs at least two lines (one debit, one credit)");
  const sum = Math.round(lines.reduce((acc, l) => acc + l.amount, 0) * 100) / 100;
  if (Math.abs(sum) > 0.004) {
    throw new ConnectorError(ErrorCode.ValidationError, `voucher is not balanced: debits minus credits = ${sum.toFixed(2)} (must be 0)`, {
      detail: { sum, lineCount: lines.length }
    });
  }
  for (const line of lines) {
    if (line.amount === 0) throw new ConnectorError(ErrorCode.ValidationError, `line "${line.ledgerName}" has amount 0`);
  }
}

export function makeVoucherTools(client: TallyClient): RegisteredTool[] {
  const createVoucher = defineTool({
    name: "tally_create_voucher",
    description:
      "Create an accounting voucher (Sales, Purchase, Payment, Receipt, Journal, Contra, Credit Note, Debit Note). Lines must balance. Sign convention: positive amount = DEBIT, negative = CREDIT (e.g. rent paid by bank: Rent +25000, HDFC Bank -25000). The connector converts this to Tally's own XML signs. Returns master_id on success; keep it to find or delete the voucher later.",
    scope: "write",
    inputSchema: {
      voucher_type: z
        .enum(["Sales", "Purchase", "Payment", "Receipt", "Journal", "Contra", "Credit Note", "Debit Note"])
        .describe("Voucher type."),
      date: dateParam.describe("Voucher date, YYYY-MM-DD."),
      lines: z
        .array(
          z.object({
            ledger_name: z.string().min(1).describe("Ledger exactly as it exists in Tally (check with tally_search_ledgers)."),
            amount: z.number().describe("Positive = debit, negative = credit.")
          })
        )
        .min(2)
        .describe("At least two lines that sum to zero."),
      party_ledger: z.string().optional().describe("Party ledger (customer/supplier) for Sales, Purchase, Receipt, Payment and notes."),
      narration: z.string().optional(),
      reference: z.string().optional().describe("Bill/invoice reference. For purchases, the supplier's invoice number (used for GSTR-2B matching)."),
      company: companyParam
    },
    handler: async (args) => {
      const input: CreateVoucherInput = {
        kind: args.voucher_type as VoucherKind,
        date: args.date,
        partyLedger: args.party_ledger,
        narration: args.narration,
        reference: args.reference,
        lines: args.lines.map((l) => ({ ledgerName: l.ledger_name, amount: l.amount }))
      };
      assertBalanced(input.lines);
      const result = await client.createVoucher(input, { dryRun: args.dry_run !== false, company: args.company });
      if ("preview" in result) {
        return {
          data: {
            previewed: true,
            summary: summarizeLines(input),
            request: result.preview,
            hint: "Balanced. Show the summary to the user; after a clear yes, re-run with dry_run=false and an idempotency_key."
          },
          meta: { preview: true }
        };
      }
      return { data: { posted: true, master_id: result.masterId, created: result.created, altered: result.altered } };
    }
  });

  const deleteVoucher = defineTool({
    name: "tally_delete_voucher",
    description:
      "Delete a voucher from Tally. Destructive and irreversible: the user must approve it in a confirmation dialog. Identify the voucher by master_id (+ voucher_type, date) from tally_find_vouchers or tally_create_voucher; remote_id or voucher_number (+ voucher_type, date) also work.",
    scope: "write",
    destructive: true,
    inputSchema: {
      master_id: z.string().optional().describe("Tally Master ID (preferred). Requires voucher_type and date."),
      remote_id: z.string().optional().describe("Tally REMOTEID/GUID of the voucher."),
      voucher_number: z.string().optional().describe("Voucher number; requires voucher_type and date."),
      voucher_type: z.string().optional().describe("Voucher type, e.g. Payment."),
      date: dateParam.optional().describe("Voucher date, YYYY-MM-DD."),
      company: companyParam
    },
    handler: async (args) => {
      const input: DeleteVoucherInput = {
        masterId: args.master_id,
        remoteId: args.remote_id,
        voucherNumber: args.voucher_number,
        voucherType: args.voucher_type,
        date: args.date
      };
      const result = await client.deleteVoucher(input, { dryRun: args.dry_run !== false, company: args.company });
      if ("preview" in result) return { data: { previewed: true, request: result.preview }, meta: { preview: true } };
      return { data: { deleted: true, counts: { deleted: result.deleted, voucherDeleted: result.voucherDeleted, altered: result.altered } } };
    }
  });

  const findVouchers = defineTool({
    name: "tally_find_vouchers",
    description:
      "Find vouchers by type and/or number within a date range. Returns master_id, remote_id, party, reference and lines (positive = debit).",
    scope: "read",
    inputSchema: {
      from_date: dateParam,
      to_date: dateParam,
      voucher_type: z.string().optional(),
      voucher_number: z.string().optional(),
      company: companyParam
    },
    handler: async (args) => {
      const entries = await client.findVouchers({
        from: args.from_date,
        to: args.to_date,
        voucherType: args.voucher_type,
        voucherNumber: args.voucher_number,
        company: args.company
      });
      return { data: { count: entries.length, vouchers: entries.slice(0, 50) }, meta: { truncated: entries.length > 50 } };
    }
  });

  return [createVoucher, deleteVoucher, findVouchers];
}

function summarizeLines(input: CreateVoucherInput): Record<string, unknown> {
  const debits = input.lines.filter((l) => l.amount > 0).map((l) => ({ ledger: l.ledgerName, amount: l.amount }));
  const credits = input.lines.filter((l) => l.amount < 0).map((l) => ({ ledger: l.ledgerName, amount: -l.amount }));
  return {
    voucher_type: input.kind,
    date: input.date,
    party: input.partyLedger,
    reference: input.reference,
    debit: debits,
    credit: credits,
    total: Math.round(debits.reduce((a, d) => a + d.amount, 0) * 100) / 100
  };
}
