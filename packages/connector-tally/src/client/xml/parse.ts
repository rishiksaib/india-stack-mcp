import { XMLParser } from "fast-xml-parser";

const parserOptions = {
  ignoreAttributes: true,
  attributeNamePrefix: "",
  trimValues: true,
  parseTagValue: false
};

export function parseXml(xmlText: string): Record<string, unknown> {
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse(xmlText) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

function envelopeOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const env = parsed["ENVELOPE"];
  if (env && typeof env === "object" && !Array.isArray(env)) return env as Record<string, unknown>;
  if (Object.keys(parsed).length > 0) return parsed;
  return {};
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyRecord(record: unknown): Record<string, string> {
  if (typeof record === "string") return { VALUE: record };
  if (!isRecord(record)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== null && typeof v !== "object") out[k.toUpperCase()] = String(v);
  }
  return out;
}

export function extractRecords(parsed: Record<string, unknown>, collectionId: string): Array<Record<string, string>> {
  const env = envelopeOf(parsed);
  const upper = collectionId.toUpperCase();
  for (const [key, val] of Object.entries(env)) {
    if (key.toUpperCase() === upper) {
      return asArray(val).map(stringifyRecord);
    }
  }
  for (const [key, val] of Object.entries(env)) {
    if (/LIST$/i.test(key)) {
      return asArray(val).map(stringifyRecord);
    }
  }
  return [];
}

export function extractDayBook(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const env = envelopeOf(parsed);
  const out: Array<Record<string, unknown>> = [];
  for (const [key, val] of Object.entries(env)) {
    if (/^DAYBOOK(\.LIST)?$/i.test(key)) {
      out.push(...asArray(val).filter(isRecord));
      continue;
    }
    if (isRecord(val)) {
      for (const [k2, v2] of Object.entries(val)) {
        if (/^DAYBOOK/i.test(k2) || /^VOUCHER$/i.test(k2)) {
          out.push(...asArray(v2).filter(isRecord));
        }
      }
    }
  }
  return out;
}

export interface RawImportResult {
  created: number;
  altered: number;
  deleted: number;
  voucherDeleted: number;
  exceptions: number;
  lineErrors: string[];
  errorsText: string[];
}

export function extractImportResult(parsed: Record<string, unknown>): RawImportResult {
  const env = envelopeOf(parsed);
  let node: Record<string, unknown> = env;
  for (const [key, val] of Object.entries(env)) {
    if (/^(IMPORTDATA|RESPONSE|VOUCHERS)$/i.test(key) && isRecord(val)) {
      node = val;
      break;
    }
  }
  const num = (name: string): number => parseInt(String(node[name] ?? "0"), 10) || 0;
  return {
    created: num("CREATED"),
    altered: num("ALTERED"),
    deleted: num("DELETED"),
    voucherDeleted: num("VCHDEL"),
    exceptions: num("EXCEPTIONS"),
    lineErrors: asArray(node["LINEERROR"]).map(String),
    errorsText: [...asArray(node["ERRORS"]).map(String), ...asArray(node["ERRORTEXT"]).map(String)]
  };
}

export function parseBalance(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).replace(/,/g, "").trim();
  if (/\bDr\b/i.test(s)) return magnitude(s, 1);
  if (/\bCr\b/i.test(s)) return magnitude(s, -1);
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? undefined : n;
}

function magnitude(s: string, sign: number): number {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return NaN;
  return sign * Math.abs(n);
}
