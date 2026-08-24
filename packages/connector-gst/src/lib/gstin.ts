export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  26: "Dadra and Nagar Haveli and Daman and Diu",
  27: "Maharashtra",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman and Nicobar Islands",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory"
};

const ENTITY_TYPES: Record<string, string> = {
  C: "Company",
  P: "Partnership / LLP / Proprietorship (PAN holder type)",
  H: "Hindu Undivided Family",
  F: "Partnership Firm",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government"
};

const CHAR_VALUES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface GstinInfo {
  valid: boolean;
  normalized: string;
  errors: string[];
  stateCode?: string;
  stateName?: string;
  pan?: string;
  entityCode?: number;
  entityType?: string;
  checksumExpected?: string;
}

function charValue(ch: string): number {
  return CHAR_VALUES.indexOf(ch);
}

function checksumChar(first14: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = first14.length - 1; i >= 0; i--) {
    const v = charValue(first14[i]!);
    const product = v * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  const rem = sum % 36;
  return CHAR_VALUES[(36 - rem) % 36]!;
}

export function computeChecksum(first14: string): string | null {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\dZ$/.test(first14)) return null;
  return checksumChar(first14);
}

export function validateGstin(input: string): GstinInfo {
  const errors: string[] = [];
  const normalized = input.trim().toUpperCase().replace(/\s|-/g, "");
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(normalized)) {
    errors.push("GSTIN must be 15 characters: state code (2 digits), PAN (10 chars), entity digit, 'Z', checksum.");
    return { valid: false, normalized, errors };
  }
  const stateCode = normalized.slice(0, 2);
  const pan = normalized.slice(2, 12);
  const entityCode = parseInt(normalized[12]!, 10);
  const expected = checksumChar(normalized.slice(0, 14));
  const actual = normalized[14]!;
  if (expected !== actual) {
    errors.push(`Checksum mismatch: last character should be "${expected}" for this GSTIN.`);
  }
  const stateName = GST_STATE_CODES[stateCode];
  if (!stateName) errors.push(`Unknown state code "${stateCode}".`);
  const entityType = ENTITY_TYPES[pan[3]!] ?? `Unknown PAN holder type "${pan[3]}"`;
  return {
    valid: errors.length === 0,
    normalized,
    errors,
    stateCode,
    stateName,
    pan,
    entityCode,
    entityType,
    checksumExpected: expected
  };
}
