import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { ZohoClient } from "../client/zohoClient.js";
import type { CreateInvoiceInput } from "../client/types.js";
import { dateParam, orgParam } from "./params.js";

export function makeInvoiceTools(client: ZohoClient): RegisteredTool[] {
  const listInvoices = defineTool({
    name: "zoho_list_invoices",
    description: "List invoices with status filter (draft, sent, overdue, paid, viewed, expired).",
    scope: "read",
    inputSchema: {
      status: z.string().optional().describe("Filter: draft|sent|overdue|paid|viewed|expired."),
      customer_id: z.string().optional(),
      page: z.number().int().min(1).default(1),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.listInvoices({
        status: args.status,
        customerId: args.customer_id,
        page: args.page,
        organizationId: args.organization_id
      });
      return {
        data: { count: result.records.length, invoices: result.records.slice(0, 50), page: result.page, hasMore: result.hasMore },
        meta: { truncated: result.records.length > 50 }
      };
    }
  });

  const getInvoice = defineTool({
    name: "zoho_get_invoice",
    description: "Get one invoice with line-item detail by invoice_id.",
    scope: "read",
    inputSchema: {
      invoice_id: z.string().min(1),
      organization_id: orgParam
    },
    handler: async (args) => {
      const invoice = await client.getInvoice(args.invoice_id, args.organization_id);
      return { data: invoice as unknown as Record<string, unknown> };
    }
  });

  const createInvoice = defineTool({
    name: "zoho_create_invoice",
    description:
      "Create an invoice for a customer. Line items reference existing item_id (rate/qty applied) or free-text name+rate. Defaults to a dry-run preview.",
    scope: "write",
    inputSchema: {
      customer_id: z.string().min(1).describe("Zoho contact_id of the customer."),
      line_items: z
        .array(
          z.object({
            item_id: z.string().optional(),
            name: z.string().optional(),
            description: z.string().optional(),
            rate: z.number().describe("Unit rate in the org's currency."),
            quantity: z.number().positive()
          })
        )
        .min(1)
        .describe("At least one line item; each needs item_id or name."),
      invoice_number: z.string().optional().describe("Custom invoice number if not auto-numbering."),
      reference_number: z.string().optional(),
      date: dateParam.optional().describe("Defaults to today."),
      due_date: dateParam.optional(),
      notes: z.string().optional(),
      organization_id: orgParam
    },
    handler: async (args) => {
      const input: CreateInvoiceInput = {
        customerId: args.customer_id,
        invoiceNumber: args.invoice_number,
        referenceNumber: args.reference_number,
        date: args.date,
        dueDate: args.due_date,
        notes: args.notes,
        lineItems: args.line_items.map((l) => ({ itemId: l.item_id, name: l.name, description: l.description, rate: l.rate, quantity: l.quantity }))
      };
      const result = await client.createInvoice(input, { dryRun: args.dry_run !== false, organizationId: args.organization_id });
      if ("preview" in result) {
        return { data: { previewed: true, request: result.preview, hint: "Re-run with dry_run=false to create the invoice." }, meta: { preview: true } };
      }
      return { data: { created: true, ...(result as unknown as Record<string, unknown>) } };
    }
  });

  return [listInvoices, getInvoice, createInvoice];
}
