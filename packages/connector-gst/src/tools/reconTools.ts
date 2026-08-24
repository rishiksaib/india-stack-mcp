import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import { reconcile2b, type Gstr2bRow, type PurchaseRow, type ReconEntry } from "../lib/recon.js";

const taxBlock = {
  igst: z.number().min(0).optional().describe("IGST amount."),
  cgst: z.number().min(0).optional(),
  sgst: z.number().min(0).optional()
};

const purchaseSchema = z.object({
  gstin: z.string().optional().describe("Supplier GSTIN as recorded in books."),
  invoice_number: z.string().optional().describe("Supplier invoice number from the purchase register."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional(),
  taxable_value: z.number().min(0),
  ...taxBlock
});

const gstr2bSchema = z.object({
  gstin: z.string().optional().describe("Supplier GSTIN from GSTR-2B."),
  invoice_number: z.string().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxable_value: z.number().min(0),
  itc_available: z.boolean().optional().describe("ITC availability flag from 2B."),
  supplier_filing_status: z.string().optional(),
  ...taxBlock
});

export function makeReconTools(): RegisteredTool[] {
  const reconcile = defineTool({
    name: "gst_reconcile_2b",
    description:
      "Reconcile your purchase register against GSTR-2B. Classifies every invoice as matched (exact/fuzzy), mismatched (value/tax deltas), missing in 2B (supplier has not filed) or missing in books, and quantifies ITC at risk vs excess claim risk.",
    scope: "read",
    inputSchema: {
      purchases: z.array(purchaseSchema).max(2000).describe("Purchase register rows for the period."),
      gstr_2b_rows: z.array(gstr2bSchema).max(2000).describe("GSTR-2B rows for the period (export from the portal/GSP)."),
      value_tolerance: z.number().default(1).describe("Absolute rupee tolerance on taxable value."),
      tax_tolerance: z.number().default(1).describe("Absolute rupee tolerance on total tax."),
      date_window_days: z.number().int().min(0).default(7).describe("Max days between book and 2B dates for fuzzy matching.")
    },
    handler: async (args) => {
      const purchases: PurchaseRow[] = args.purchases.map((p) => ({
        gstin: p.gstin,
        invoiceNumber: p.invoice_number,
        date: p.date,
        taxableValue: p.taxable_value,
        igst: p.igst,
        cgst: p.cgst,
        sgst: p.sgst
      }));
      const rows2b: Gstr2bRow[] = args.gstr_2b_rows.map((r) => ({
        gstin: r.gstin,
        invoiceNumber: r.invoice_number,
        invoiceDate: r.invoice_date,
        taxableValue: r.taxable_value,
        igst: r.igst,
        cgst: r.cgst,
        sgst: r.sgst,
        itcAvailable: r.itc_available,
        supplierFilingStatus: r.supplier_filing_status
      }));

      const report = reconcile2b(purchases, rows2b, {
        valueTolerance: args.value_tolerance,
        taxTolerance: args.tax_tolerance,
        dateWindowDays: args.date_window_days
      });

      const actionable = report.entries.filter((e) => e.status !== "matched_exact").slice(0, 200);
      const entries: Array<Omit<ReconEntry, never>> = actionable;
      return {
        data: {
          summary: report.summary,
          entries_needing_action: entries,
          config: report.config
        },
        meta: {
          truncated: report.entries.length > actionable.length,
          guidance:
            "missing_in_books = ITC claimable once booked; missing_in_2b = do not claim until the supplier files; mismatch = chase the supplier before filing GSTR-3B."
        }
      };
    }
  });

  return [reconcile];
}
