import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import { SUPPLY_TYPES, buildEinvoicePayload, type SupplyType } from "../lib/einvoice.js";
import type { EinvoiceDocInput, EinvoiceItem, EinvoiceParty } from "../lib/einvoice.js";
import { irpFromEnv } from "../irp/irpClient.js";

export const partySchema = z.object({
  gstin: z.string().describe("15-character GSTIN. For an export buyer use \"URP\"."),
  legal_name: z.string().min(1).describe("Registered legal name."),
  address: z.string().min(1).describe("Building/flat, street."),
  location: z.string().min(1).describe("City or town."),
  pincode: z.string().regex(/^\d{6}$/, "pincode must be 6 digits").describe("6-digit PIN (use 999999 for an export buyer)."),
  state_code: z.string().regex(/^\d{2}$/, "state code must be 2 digits").describe("2-digit GST state code; must match the GSTIN's first two digits."),
  email: z.string().optional(),
  phone: z.string().optional()
});

export const itemSchema = z.object({
  description: z.string().optional(),
  hsn_code: z.string().regex(/^\d{4,8}$/, "HSN/SAC must be 4-8 digits").describe("HSN (goods) or SAC (services, starts with 99)."),
  is_service: z.boolean().optional().describe("Defaults to true when the code starts with 99 (SAC)."),
  quantity: z.number().positive(),
  unit: z.string().optional().describe("UQC like NOS, KGS, PCS, MTR. Defaults to NOS (goods) or OTH (services)."),
  unit_price: z.number().min(0).describe("Taxable rate per unit, before GST."),
  tax_rate_percent: z.number().describe("GST rate percent: 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28 or 40.")
});

const docInputShape = {
  document_number: z.string().min(1).max(16).describe("Document number as it appears on the invoice (max 16 characters)."),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  document_type: z.enum(["INV", "CRN", "DBN"]).default("INV").describe("INV invoice, CRN credit note, DBN debit note."),
  supply_type: z
    .enum(SUPPLY_TYPES as [SupplyType, ...SupplyType[]])
    .default("B2B")
    .describe("B2B, SEZWP/SEZWOP (SEZ with/without payment of tax), EXPWP/EXPWOP (export with/without payment), DEXP (deemed export)."),
  place_of_supply: z
    .string()
    .regex(/^\d{2}$/)
    .optional()
    .describe("2-digit state code of the place of supply. Defaults to the buyer's state (96 for exports). Decides CGST+SGST vs IGST."),
  reverse_charge: z.boolean().default(false),
  round_off: z.boolean().default(false).describe("Round the total to the nearest rupee and record the difference."),
  seller: partySchema,
  buyer: partySchema,
  items: z.array(itemSchema).min(1)
};

type PartyArgs = z.infer<typeof partySchema>;
type ItemArgs = z.infer<typeof itemSchema>;

function toParty(p: PartyArgs): EinvoiceParty {
  return {
    gstin: p.gstin,
    legalName: p.legal_name,
    address: p.address,
    location: p.location,
    pincode: p.pincode,
    stateCode: p.state_code,
    email: p.email,
    phone: p.phone
  };
}

function toItem(i: ItemArgs, idx: number): EinvoiceItem {
  return {
    serialNo: idx + 1,
    description: i.description,
    hsnCode: i.hsn_code,
    isService: i.is_service,
    quantity: i.quantity,
    unit: i.unit,
    unitPrice: i.unit_price,
    taxRatePercent: i.tax_rate_percent
  };
}

/** Map the tool's snake_case arguments onto the library's camelCase input. */
export function toDomain(args: {
  document_number: string;
  document_date: string;
  document_type?: "INV" | "CRN" | "DBN";
  supply_type?: SupplyType;
  place_of_supply?: string;
  reverse_charge?: boolean;
  round_off?: boolean;
  seller: PartyArgs;
  buyer: PartyArgs;
  items: ItemArgs[];
}): EinvoiceDocInput {
  return {
    documentNumber: args.document_number,
    documentDate: args.document_date,
    documentType: args.document_type,
    supplyType: args.supply_type,
    placeOfSupply: args.place_of_supply,
    reverseCharge: args.reverse_charge,
    roundOff: args.round_off,
    seller: toParty(args.seller),
    buyer: toParty(args.buyer),
    items: args.items.map(toItem)
  };
}

export function makeEinvoiceTools(): RegisteredTool[] {
  const build = defineTool({
    name: "gst_einvoice_build",
    description:
      "Build the e-invoice JSON (schema v1.1) for one invoice: per-item IGST or CGST+SGST split by place of supply, totals and optional rupee round-off. Pure computation; nothing is sent anywhere. Upload the result through the e-invoice portal or a GSP to get the IRN.",
    scope: "read",
    inputSchema: docInputShape,
    handler: async (args) => {
      const payload = buildEinvoicePayload(toDomain(args));
      return {
        data: { payload, totals: payload.ValDtls },
        meta: { schema: "e-invoice schema v1.1", note: "No IRN yet. This JSON is what the IRP receives." }
      };
    }
  });

  const generate = defineTool({
    name: "gst_einvoice_generate",
    description:
      "Generate an IRN for an invoice. The dry-run (default) builds and validates the payload. Live generation needs a licensed IRP/GSP integration, which is not included: without one the call is refused rather than returning a fake IRN.",
    scope: "write",
    inputSchema: docInputShape,
    handler: async (args) => {
      const payload = buildEinvoicePayload(toDomain(args));
      if (args.dry_run !== false) {
        return {
          data: {
            previewed: true,
            payload,
            irp_note: "No IRP call was made. Live IRN generation needs a licensed IRP/GSP integration."
          },
          meta: { preview: true }
        };
      }
      const irp = irpFromEnv();
      const result = await irp.generateIrn(JSON.stringify(payload));
      return {
        data: { generated: true, legally_valid: result.irp !== "mock", ...result },
        meta: result.irp === "mock" ? { warning: "MOCK IRP (INDIA_STACK_IRP=mock): this IRN is synthetic and must never be printed on an invoice." } : undefined
      };
    }
  });

  return [build, generate];
}
