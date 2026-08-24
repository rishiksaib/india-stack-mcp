import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { TallyClient } from "../client/tallyClient.js";

const companyParam = z.string().optional().describe("Company name in Tally; defaults to the connector's configured company.");

export function makeCompanyTools(client: TallyClient): RegisteredTool[] {
  const listCompanies = defineTool({
    name: "tally_list_companies",
    description: "List all companies registered in the connected TallyPrime instance.",
    scope: "read",
    inputSchema: {},
    handler: async () => {
      const companies = await client.listCompanies();
      return { data: { count: companies.length, companies }, meta: { source: "collection:Company" } };
    }
  });

  const getCompany = defineTool({
    name: "tally_get_company",
    description: "Get one company's details (GUID, books start date) by exact name.",
    scope: "read",
    inputSchema: {
      name: z.string().describe("Exact company name as shown in Tally."),
      company: companyParam
    },
    handler: async (args) => {
      const found = await client.getCompany(args.name);
      return { data: found as unknown as Record<string, unknown> };
    }
  });

  return [listCompanies, getCompany];
}
