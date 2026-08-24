import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export function makeReportTools(client: TallyClient): RegisteredTool[] {
  const dayBook = defineTool({
    name: "tally_day_book",
    description: "Read the Day Book (all vouchers) between two dates.",
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
    description: "Trial-balance style view: every ledger's closing balance grouped under its parent group.",
    scope: "read",
    inputSchema: {
      as_of: dateParam.optional().describe("Informational; balances are current closing values from Tally."),
      parent: z.string().optional().describe("Restrict to one group."),
      company: companyParam
    },
    handler: async (args) => {
      const ledgers = await client.ledgerBalances({ parent: args.parent, company: args.company });
      const groups: Record<string, { totalDebit: number; totalCredit: number; ledgers: Array<{ name: string; closingBalance?: number }> }> = {};
      for (const l of ledgers) {
        const g = l.parent ?? "(no group)";
        groups[g] ??= { totalDebit: 0, totalCredit: 0, ledgers: [] };
        groups[g]!.ledgers.push({ name: l.name, closingBalance: l.closingBalance });
        const bal = l.closingBalance ?? 0;
        if (bal >= 0) groups[g]!.totalDebit += bal;
        else groups[g]!.totalCredit += -bal;
      }
      return {
        data: {
          groups: Object.entries(groups)
            .map(([group, v]) => ({ group, ...v }))
            .sort((a, b) => b.totalDebit - a.totalDebit),
          ledgerCount: ledgers.length
        },
        meta: { source: "collection:Ledger", signConvention: "positive=debit, negative=credit" }
      };
    }
  });

  const ledgerBalances = defineTool({
    name: "tally_ledger_balances",
    description: "Closing balances for all ledgers, optionally filtered by parent group.",
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
        meta: { truncated: ledgers.length > 150 }
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

  return [dayBook, trialBalance, ledgerBalances, listVoucherTypes];
}
