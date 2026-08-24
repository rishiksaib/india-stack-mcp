import { z } from "zod";

export const orgParam = z.string().optional().describe("Zoho organization_id; defaults to the connector's configured organization.");
export const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
