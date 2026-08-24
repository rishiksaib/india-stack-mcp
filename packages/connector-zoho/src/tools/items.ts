import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { ZohoClient } from "../client/zohoClient.js";
import { orgParam } from "./params.js";

export function makeItemTools(client: ZohoClient): RegisteredTool[] {
  const listItems = defineTool({
    name: "zoho_list_items",
    description: "List products/services (items) available for invoices, with rates.",
    scope: "read",
    inputSchema: {
      query: z.string().optional().describe("Search by name/sku."),
      page: z.number().int().min(1).default(1),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.listItems({ query: args.query, page: args.page, organizationId: args.organization_id });
      return { data: { count: result.records.length, items: result.records.slice(0, 50), hasMore: result.hasMore } };
    }
  });

  const createItem = defineTool({
    name: "zoho_create_item",
    description: "Create a product/service item with a rate. Defaults to a dry-run preview.",
    scope: "write",
    inputSchema: {
      name: z.string().min(1),
      rate: z.number().min(0).describe("Selling rate."),
      description: z.string().optional(),
      sku: z.string().optional(),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.createItem(
        { name: args.name, rate: args.rate, description: args.description, sku: args.sku },
        { dryRun: args.dry_run !== false, organizationId: args.organization_id }
      );
      if ("preview" in result) {
        return { data: { previewed: true, request: result.preview, hint: "Re-run with dry_run=false to create the item." }, meta: { preview: true } };
      }
      return { data: { created: true, ...(result as unknown as Record<string, unknown>) } };
    }
  });

  return [listItems, createItem];
}
