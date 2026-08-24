import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");

export function makeLedgerTools(client: TallyClient): RegisteredTool[] {
  const searchLedgers = defineTool({
    name: "tally_search_ledgers",
    description: "Search ledger accounts by name substring and/or parent group. Returns name, group, opening and closing balances.",
    scope: "read",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring of the ledger name."),
      parent: z.string().optional().describe("Filter by parent group, e.g. 'Sundry Debtors', 'Bank Accounts'."),
      company: companyParam
    },
    handler: async (args) => {
      const ledgers = await client.searchLedgers({ query: args.query, parent: args.parent, company: args.company });
      return { data: { count: ledgers.length, ledgers: ledgers.slice(0, 100) } };
    }
  });

  const getLedger = defineTool({
    name: "tally_get_ledger",
    description: "Get one ledger account by exact name with balances.",
    scope: "read",
    inputSchema: {
      name: z.string().describe("Exact ledger name."),
      company: companyParam
    },
    handler: async (args) => {
      const found = await client.getLedger(args.name, args.company);
      return { data: found as unknown as Record<string, unknown> };
    }
  });

  const createLedger = defineTool({
    name: "tally_create_ledger",
    description: "Create a new ledger account under a Tally group (e.g. 'Sundry Debtors', 'Indirect Expenses').",
    scope: "write",
    inputSchema: {
      name: z.string().min(1).describe("New ledger name; must not already exist."),
      parent: z.string().min(1).describe("Parent group exactly as named in Tally."),
      opening_balance: z.string().default("0").describe("Opening balance like '0' or '-5000' (negative = credit)."),
      company: companyParam
    },
    handler: async (args) => {
      const result = await client.createLedger(
        { name: args.name, parent: args.parent, openingBalance: args.opening_balance ?? "0" },
        { dryRun: args.dry_run !== false, company: args.company }
      );
      if ("preview" in result) return { data: { previewed: true, request: result.preview }, meta: { preview: true } };
      return { data: { created: result.created, ledger: args.name, parent: args.parent } };
    }
  });

  return [searchLedgers, getLedger, createLedger];
}
