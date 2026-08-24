import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { ZohoClient } from "../client/zohoClient.js";
import { orgParam } from "./params.js";

export function makeContactTools(client: ZohoClient): RegisteredTool[] {
  const listContacts = defineTool({
    name: "zoho_list_contacts",
    description: "List customers or vendors with outstanding balances. Supports text search.",
    scope: "read",
    inputSchema: {
      type: z.enum(["customer", "vendor"]).optional().describe("Filter by contact type."),
      query: z.string().optional().describe("Search name/email/phone substring."),
      page: z.number().int().min(1).default(1).describe("Page number."),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.listContacts({
        type: args.type,
        query: args.query,
        page: args.page,
        organizationId: args.organization_id
      });
      return {
        data: { count: result.records.length, contacts: result.records, page: result.page, hasMore: result.hasMore },
        meta: { truncated: result.records.length > 50 }
      };
    }
  });

  const getContact = defineTool({
    name: "zoho_get_contact",
    description: "Get full details for one contact by contact_id.",
    scope: "read",
    inputSchema: {
      contact_id: z.string().min(1).describe("Zoho contact_id (from zoho_list_contacts)."),
      organization_id: orgParam
    },
    handler: async (args) => {
      const contact = await client.getContact(args.contact_id, args.organization_id);
      return { data: contact as unknown as Record<string, unknown> };
    }
  });

  const createContact = defineTool({
    name: "zoho_create_contact",
    description: "Create a customer or vendor. GSTIN is validated by Zoho when provided.",
    scope: "write",
    inputSchema: {
      name: z.string().min(1).describe("Display name of the contact."),
      type: z.enum(["customer", "vendor"]).optional().default("customer"),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]$/, "GSTIN must be a valid 15-character GSTIN").optional(),
      place_of_contact: z.string().optional().describe("Place of supply state code or name."),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.createContact(
        {
          name: args.name,
          type: args.type ?? "customer",
          email: args.email,
          phone: args.phone,
          gstin: args.gstin,
          placeOfContact: args.place_of_contact
        },
        { dryRun: args.dry_run !== false, organizationId: args.organization_id }
      );
      if ("preview" in result) {
        return { data: { previewed: true, request: result.preview, hint: "Re-run with dry_run=false to create in Zoho Books." }, meta: { preview: true } };
      }
      return { data: { created: true, ...(result as unknown as Record<string, unknown>) } };
    }
  });

  return [listContacts, getContact, createContact];
}
