import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import { reconcile2b, type Gstr2bRow, type PurchaseRow } from "../lib/recon.js";

const taxBlock = {
  igst: z.number().optional().describe("IGST amount (negative on credit notes)."),
  cgst: z.number().optional(),
  sgst: z.number().optional().describe("SGST or UTGST amount."),
  cess: z.number().optional()
};

const purchaseSchema = z.object({
  gstin: z.string().optional().describe("Supplier GSTIN as recorded in books."),
  invoice_number: z.string().optional().describe("Supplier invoice number from the purchase register."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional(),
  taxable_value: z.number().describe("Taxable value; negative for credit notes / purchase returns."),
  ...taxBlock
});

const gstr2bSchema = z.object({
  gstin: z.string().optional().describe("Supplier GSTIN from GSTR-2B."),
  invoice_number: z.string().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxable_value: z.number().describe("Taxable value; negative for credit notes (2B CDNR section)."),
  itc_available: z.boolean().optional().describe("2B 'ITC availability' flag; false = not available."),
  supplier_filing_status: z.string().optional(),
  ...taxBlock
});

const MAX_ENTRIES = 200;

export function makeReconTools(): RegisteredTool[] {
  const reconcile = defineTool({
    name: "gst_reconcile_2b",
    description:
      "Reconcile a purchase register (e.g. from tally_purchase_register) against GSTR-2B. Classifies every invoice as matched (exact/fuzzy), mismatched (value/tax deltas), missing in 2B (supplier has not filed), or missing in books; flags matched invoices whose ITC 2B marks as not available; handles credit notes and cess.",
    scope: "read",
    inputSchema: {
      purchases: z.array(purchaseSchema).max(5000).describe("Purchase register rows for the period."),
      gstr_2b_rows: z.array(gstr2bSchema).max(5000).describe("GSTR-2B rows for the period (from the portal or a GSP)."),
      value_tolerance: z.number().min(0).default(1).describe("Absolute rupee tolerance on taxable value."),
      tax_tolerance: z.number().min(0).default(1).describe("Absolute rupee tolerance on total tax."),
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
        sgst: p.sgst,
        cess: p.cess
      }));
      const rows2b: Gstr2bRow[] = args.gstr_2b_rows.map((r) => ({
        gstin: r.gstin,
        invoiceNumber: r.invoice_number,
        invoiceDate: r.invoice_date,
        taxableValue: r.taxable_value,
        igst: r.igst,
        cgst: r.cgst,
        sgst: r.sgst,
        cess: r.cess,
        itcAvailable: r.itc_available,
        supplierFilingStatus: r.supplier_filing_status
      }));

      const report = reconcile2b(purchases, rows2b, {
        valueTolerance: args.value_tolerance,
        taxTolerance: args.tax_tolerance,
        dateWindowDays: args.date_window_days
      });

      // Clean exact matches need no action and are left out to keep the response small.
      const actionable = report.entries.filter((e) => e.status !== "matched_exact" || e.itcUnavailable);
      return {
        data: {
          summary: report.summary,
          entries_needing_action: actionable.slice(0, MAX_ENTRIES),
          config: report.config
        },
        meta: {
          truncated: actionable.length > MAX_ENTRIES,
          actionable_total: actionable.length,
          guidance:
            "missing_in_2b = do not claim until the supplier files (excessClaimRisk); mismatch = chase the supplier before filing GSTR-3B; missing_in_books = ITC claimable once booked (itcAtRisk); itcUnavailable = 2B says this ITC cannot be claimed (ineligibleItc)."
        }
      };
    }
  });

  return [reconcile];
}
