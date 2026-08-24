import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import { buildEinvoicePayload } from "../lib/einvoice.js";
import { encryptForIrp } from "../lib/crypto.js";
import type { EinvoiceDocInput, EinvoiceItem, EinvoiceParty } from "../lib/einvoice.js";
import { irpFromEnv } from "../irp/irpClient.js";

export const partySchema = z.object({
  gstin: z.string().describe("15-character GSTIN."),
  legal_name: z.string().describe("Registered legal name."),
  address: z.string().describe("Building/flat, street."),
  location: z.string().describe("City or town."),
  pincode: z.string().regex(/^\d{6}$/, "pincode must be 6 digits"),
  state_code: z.string().regex(/^\d{2}$/, "state code must be 2 digits"),
  email: z.string().optional(),
  phone: z.string().optional()
});

export const itemSchema = z.object({
  description: z.string().optional(),
  hsn_code: z.string().regex(/^\d{4,8}$/, "HSN must be 4-8 digits").describe("HSN/SAC code."),
  quantity: z.number().positive(),
  unit: z.string().optional().default("NOS").describe("UQC like NOS, KGS, PCS, MTR."),
  unit_price: z.number().min(0).describe("Taxable rate per unit."),
  tax_rate_percent: z.number().describe("GST rate percent: 0, 0.1, 0.25, 1, 1.5, 3, 5, 12, 18 or 28.")
});

const docInputShape = {
  document_number: z.string().min(1).describe("Invoice number as it will appear on the document."),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  supply_type: z.enum(["B2B", "B2C", "SEZ", "EXP", "DE"]).default("B2B"),
  seller: partySchema,
  buyer: partySchema,
  items: z.array(itemSchema).min(1)
};

function toDomain(args: {
  document_number: string;
  document_date: string;
  supply_type?: string;
  seller: z.infer<typeof partySchema>;
  buyer: z.infer<typeof partySchema>;
  items: Array<z.infer<typeof itemSchema>>;
}): EinvoiceDocInput {
  return {
    documentNumber: args.document_number,
    documentDate: args.document_date,
    supplyType: args.supply_type as EinvoiceDocInput["supplyType"],
    seller: args.seller as unknown as EinvoiceParty,
    buyer: args.buyer as unknown as EinvoiceParty,
    items: args.items.map((i) => ({ ...i, unit: i.unit }) as unknown as EinvoiceItem)
  };
}

export function makeEinvoiceTools(): RegisteredTool[] {
  const build = defineTool({
    name: "gst_einvoice_build",
    description:
      "Build the canonical NIC e-invoice JSON payload (v1.01) for one invoice: computes per-item IGST/CGST/SGST splits, totals and round-off. Pure computation; nothing is sent anywhere.",
    scope: "read",
    inputSchema: docInputShape,
    handler: async (args) => {
      const payload = buildEinvoicePayload(toDomain(args));
      return {
        data: { payload, totals: payload.ValDtls },
        meta: { schema: "e-invoice v1.01", note: "IRN generation is a separate step." }
      };
    }
  });

  const generate = defineTool({
    name: "gst_einvoice_generate",
    description:
      "Generate an IRN for an invoice. Dry-run (default) builds the payload and, when seller_public_key_pem is provided, the encrypted NIC request envelope. Execution requires a configured IRP client (mock by default).",
    scope: "write",
    inputSchema: {
      ...docInputShape,
      seller_public_key_pem: z
        .string()
        .optional()
        .describe("Seller RSA public key in PEM (from the IRP /publickey endpoint) used to wrap the SEK in the encrypted request.")
    },
    handler: async (args) => {
      const domain = toDomain(args);
      const payload = buildEinvoicePayload(domain);
      const payloadJson = JSON.stringify(payload);

      if (args.dry_run !== false) {
        const data: Record<string, unknown> = {
          previewed: true,
          payload,
          irp_note: "No IRP call was made. Configure a licensed IRP client (NIC/GSP) and pass dry_run=false to generate a real IRN."
        };
        if (args.seller_public_key_pem) {
          const envelope = encryptForIrp(payloadJson, args.seller_public_key_pem);
          data.envelope = envelope;
        }
        return { data, meta: { preview: true } };
      }

      const irp = irpFromEnv();
      const result = await irp.generateIrn(payloadJson);
      return {
        data: { generated: true, ...result },
        meta: { warning: result.irp === "mock" ? "MOCK IRP client returned a synthetic IRN - not valid for compliance." : undefined }
      };
    }
  });

  return [build, generate];
}
