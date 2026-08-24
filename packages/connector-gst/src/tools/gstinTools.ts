import { z } from "zod";
import { defineTool, type RegisteredTool } from "@india-stack/core";
import { validateGstin } from "../lib/gstin.js";

export function makeGstinTools(): RegisteredTool[] {
  const validate = defineTool({
    name: "gst_validate_gstin",
    description:
      "Validate a GSTIN: mod-36 checksum, state code lookup, PAN extraction and entity type. Use before quoting any GSTIN in filings or e-invoices.",
    scope: "read",
    inputSchema: {
      gstin: z.string().describe("GSTIN to validate (15 characters; whitespace/hyphens tolerated).")
    },
    handler: async (args) => {
      const info = validateGstin(args.gstin);
      return {
        data: {
          valid: info.valid,
          gstin: info.normalized,
          errors: info.errors,
          state_code: info.stateCode,
          state_name: info.stateName,
          pan: info.pan,
          entity_type: info.entityType
        }
      };
    }
  });

  return [validate];
}
