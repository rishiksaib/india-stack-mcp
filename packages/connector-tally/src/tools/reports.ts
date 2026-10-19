import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";
import { buildPurchaseRegister } from "../lib/purchaseRegister.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function makeReportTools(client: TallyClient): RegisteredTool[] {
  const dayBook = defineTool({
    name: "tally_day_book",
    description: "Read the Day Book (all vouchers) between two dates. Each voucher includes master_id, party, reference and lines (positive = debit).",
    scope: "read",
    inputSchema: {
      from_date: dateParam,
      to_date: dateParam,
      company: companyParam
    },
    handler: async (args) => {
      const entries = await client.dayBook({ from: args.from_date, to: args.to_date, company: args.company });
      return {
        data: { count: entries.length, entries: entries.slice(0, 100) },
        meta: { truncated: entries.length > 100 }
      };
    }
  });

  const trialBalance = defineTool({
    name: "tally_trial_balance",
    description:
      "Trial-balance style view from current ledger closing balances, grouped by parent group, with total debit, total credit and the difference (should be 0).",
    scope: "read",
    inputSchema: {
      parent: z.string().optional().describe("Restrict to one group (totals then cover only that group)."),
      company: companyParam
    },
    handler: async (args) => {
      const ledgers = await client.ledgerBalances({ parent: args.parent, company: args.company });
      const groups: Record<string, { totalDebit: number; totalCredit: number; ledgers: Array<{ name: string; closingBalance?: number }> }> = {};
      let totalDebit = 0;
      let totalCredit = 0;
      for (const l of ledgers) {
        const g = l.parent ?? "(no group)";
        groups[g] ??= { totalDebit: 0, totalCredit: 0, ledgers: [] };
        groups[g]!.ledgers.push({ name: l.name, closingBalance: l.closingBalance });
        const bal = l.closingBalance ?? 0;
        if (bal >= 0) {
          groups[g]!.totalDebit += bal;
          totalDebit += bal;
        } else {
          groups[g]!.totalCredit += -bal;
          totalCredit += -bal;
        }
      }
      return {
        data: {
          totals: { debit: round2(totalDebit), credit: round2(totalCredit), difference: round2(totalDebit - totalCredit) },
          groups: Object.entries(groups)
            .map(([group, v]) => ({ group, totalDebit: round2(v.totalDebit), totalCredit: round2(v.totalCredit), ledgers: v.ledgers }))
            .sort((a, b) => b.totalDebit + b.totalCredit - (a.totalDebit + a.totalCredit)),
          ledgerCount: ledgers.length
        },
        meta: {
          source: "collection:Ledger (current closing balances)",
          signConvention: "positive = debit, negative = credit",
          note: args.parent ? "Filtered to one group, so debit and credit totals are not expected to match." : "A non-zero difference usually means an opening-balance difference in Tally."
        }
      };
    }
  });

  const ledgerBalances = defineTool({
    name: "tally_ledger_balances",
    description: "Closing balances for all ledgers (positive = debit), optionally filtered by parent group.",
    scope: "read",
    inputSchema: {
      parent: z.string().optional(),
      company: companyParam
    },
    handler: async (args) => {
      const ledgers = await client.ledgerBalances({ parent: args.parent, company: args.company });
      return {
        data: {
          count: ledgers.length,
          balances: ledgers.slice(0, 150).map((l) => ({ name: l.name, parent: l.parent, closing: l.closingBalance, opening: l.openingBalance }))
        },
        meta: { truncated: ledgers.length > 150, signConvention: "positive = debit, negative = credit" }
      };
    }
  });

  const listVoucherTypes = defineTool({
    name: "tally_list_voucher_types",
    description: "List voucher types available in the company (useful before creating vouchers).",
    scope: "read",
    inputSchema: { company: companyParam },
    handler: async (args) => {
      const types = await client.listVoucherTypes(args.company);
      return { data: { count: types.length, voucherTypes: types } };
    }
  });

  const purchaseRegister = defineTool({
    name: "tally_purchase_register",
    description:
      "Purchase register for a period, built from Purchase and Debit Note vouchers: supplier GSTIN, supplier bill number (voucher REFERENCE), date, taxable value and IGST/CGST/SGST/cess. Rows are shaped to pass straight into gst_reconcile_2b as `purchases`. Tax ledgers are recognised by name (IGST/CGST/SGST/UTGST/Cess) unless tax_ledgers is given.",
    scope: "read",
    inputSchema: {
      from_date: dateParam,
      to_date: dateParam,
      tax_ledgers: z
        .object({
          igst: z.array(z.string()).optional(),
          cgst: z.array(z.string()).optional(),
          sgst: z.array(z.string()).optional(),
          cess: z.array(z.string()).optional()
        })
        .optional()
        .describe("Exact input-tax ledger names, if they don't contain IGST/CGST/SGST/Cess."),
      company: companyParam
    },
    handler: async (args) => {
      const [vouchers, ledgers] = await Promise.all([
        client.dayBook({ from: args.from_date, to: args.to_date, company: args.company }),
        client.searchLedgers({ company: args.company })
      ]);
      const gstins = new Map<string, string>();
      for (const l of ledgers) if (l.gstin) gstins.set(l.name.trim().toLowerCase(), l.gstin);
      const rows = buildPurchaseRegister(vouchers, gstins, args.tax_ledgers ?? {});
      const withWarnings = rows.filter((r) => r.warnings.length > 0).length;
      const total = (k: "taxable_value" | "igst" | "cgst" | "sgst" | "cess") => round2(rows.reduce((a, r) => a + r[k], 0));
      return {
        data: {
          count: rows.length,
          totals: { taxable_value: total("taxable_value"), igst: total("igst"), cgst: total("cgst"), sgst: total("sgst"), cess: total("cess") },
          rows_with_warnings: withWarnings,
          purchases: rows
        },
        meta: { next: "Pass `purchases` with the period's GSTR-2B rows to gst_reconcile_2b." }
      };
    }
  });

  return [dayBook, trialBalance, ledgerBalances, listVoucherTypes, purchaseRegister];
}
