import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { ZohoClient } from "../client/zohoClient.js";
import type { CreatePaymentInput } from "../client/types.js";
import { dateParam, orgParam } from "./params.js";

export function makeFinanceTools(client: ZohoClient): RegisteredTool[] {
  const chartOfAccounts = defineTool({
    name: "zoho_chart_of_accounts",
    description: "List the chart of accounts with types and balances.",
    scope: "read",
    inputSchema: {
      page: z.number().int().min(1).default(1),
      organization_id: orgParam
    },
    handler: async (args) => {
      const result = await client.chartOfAccounts({ page: args.page, organizationId: args.organization_id });
      return { data: { count: result.records.length, accounts: result.records.slice(0, 100), hasMore: result.hasMore } };
    }
  });

  const createCustomerPayment = defineTool({
    name: "zoho_create_customer_payment",
    description:
      "Record a customer payment against an invoice (or on-account if no invoice_id). Amount is applied to the invoice. Defaults to a dry-run preview.",
    scope: "write",
    inputSchema: {
      customer_id: z.string().min(1),
      amount: z.number().positive().describe("Amount received."),
      date: dateParam.describe("Payment date, YYYY-MM-DD."),
      payment_mode: z
        .string()
        .optional()
        .default("banktransfer")
        .describe("Payment mode as set up in the Zoho org, e.g. cash, banktransfer, check, creditcard, or a custom mode such as UPI."),
      invoice_id: z.string().optional().describe("Invoice the payment applies to."),
      reference_number: z.string().optional(),
      description: z.string().optional(),
      organization_id: orgParam
    },
    handler: async (args) => {
      const input: CreatePaymentInput = {
        customerId: args.customer_id,
        amount: args.amount,
        date: args.date,
        paymentMode: args.payment_mode,
        invoiceId: args.invoice_id,
        referenceNumber: args.reference_number,
        description: args.description
      };
      const result = await client.createCustomerPayment(input, { dryRun: args.dry_run !== false, organizationId: args.organization_id });
      if ("preview" in result) {
        return { data: { previewed: true, request: result.preview, hint: "Re-run with dry_run=false to record the payment." }, meta: { preview: true } };
      }
      return { data: { recorded: true, ...(result as Record<string, unknown>) } };
    }
  });

  return [chartOfAccounts, createCustomerPayment];
}
