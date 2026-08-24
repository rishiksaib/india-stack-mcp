import { z } from "zod";
import { ConnectorError, ErrorCode, defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";
import type { CreateVoucherInput, DeleteVoucherInput, VoucherKind } from "../client/types.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export function assertBalanced(lines: Array<{ ledgerName: string; amount: number }>): void {
  if (!lines.length) throw new ConnectorError(ErrorCode.ValidationError, "voucher needs at least one line");
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
      "Create an accounting voucher (Sales, Purchase, Payment, Receipt, Journal, Credit Note, Debit Note). Lines must balance: positive amounts are debits, negative are credits. Defaults to a dry-run preview.",
    scope: "write",
    inputSchema: {
      voucher_type: z.enum(["Sales", "Purchase", "Payment", "Receipt", "Journal", "Credit Note", "Debit Note"]).describe("Voucher type."),
      date: dateParam.describe("Voucher date, YYYY-MM-DD."),
      lines: z
        .array(
          z.object({
            ledger_name: z.string().min(1).describe("Ledger exactly as it exists in Tally."),
            amount: z.number().describe("Signed amount: positive = debit, negative = credit.")
          })
        )
        .min(2)
        .describe("At least two balanced lines."),
      party_ledger: z.string().optional().describe("Party ledger for party-type vouchers."),
      narration: z.string().optional(),
      reference: z.string().optional().describe("Invoice/bill reference number."),
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
            request: result.preview,
            hint: "Balanced. Re-run with dry_run=false to post into Tally."
          },
          meta: { preview: true }
        };
      }
      return { data: { posted: true, ...result } as Record<string, unknown> };
    }
  });

  const deleteVoucher = defineTool({
    name: "tally_delete_voucher",
    description: "Delete a voucher from Tally. Destructive: pass remote_id from day-book results when possible.",
    scope: "write",
    destructive: true,
    inputSchema: {
      remote_id: z.string().optional().describe("Tally REMOTEID/GUID of the voucher (preferred)."),
      voucher_number: z.string().optional().describe("Voucher number if no remote_id."),
      voucher_type: z.string().optional().describe("Required with voucher_number."),
      date: dateParam.optional().describe("Required with voucher_number."),
      company: companyParam
    },
    handler: async (args) => {
      const input: DeleteVoucherInput = {
        remoteId: args.remote_id,
        voucherNumber: args.voucher_number,
        voucherType: args.voucher_type,
        date: args.date
      };
      const result = await client.deleteVoucher(input, { dryRun: args.dry_run !== false, company: args.company });
      if ("preview" in result) return { data: { previewed: true, request: result.preview }, meta: { preview: true } };
      return { data: { deleted: result.deleted + result.voucherDeleted } as Record<string, unknown> };
    }
  });

  const findVouchers = defineTool({
    name: "tally_find_vouchers",
    description: "Find vouchers by number and/or type within a date range using the Day Book.",
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
