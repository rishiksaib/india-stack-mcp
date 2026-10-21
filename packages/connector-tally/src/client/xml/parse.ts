import { XMLParser } from "fast-xml-parser";

// Attributes matter in Tally responses: collection records carry their name as an attribute
// (<LEDGER NAME="Rent">) and vouchers carry REMOTEID as an attribute.
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
};

export function parseXml(xmlText: string): Record<string, unknown> {
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse(xmlText) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text content of a node: plain string, or the #text of an element that also has attributes. */
export function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (isRecord(value)) {
    const t = value["#text"];
    if (t !== undefined && t !== null) return String(t);
    return undefined;
  }
  return undefined;
}

// Real TallyPrime responses carry a CMPINFO block of object counts (<VOUCHER>4</VOUCHER>,
// <LEDGER>17</LEDGER>, ...). Those are not records and must never be searched.
const SKIP_SUBTREES = new Set(["CMPINFO"]);

/** Depth-first search for elements whose tag matches, at any depth, in document order. */
export function findElements(node: unknown, match: (tag: string) => boolean, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const n of node) findElements(n, match, out);
    return out;
  }
  if (!isRecord(node)) return out;
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text" || SKIP_SUBTREES.has(key.toUpperCase())) continue;
    if (match(key)) {
      for (const v of asArray(val)) {
        if (isRecord(v)) out.push(v);
        else if (typeof v === "string") out.push({ "#text": v });
      }
      continue;
    }
    findElements(val, match, out);
  }
  return out;
}

function nameOf(record: Record<string, unknown>): string | undefined {
  const attr = record["@_NAME"];
  if (typeof attr === "string" && attr !== "") return attr;
  const direct = textOf(record["NAME"]);
  if (direct) return direct;
  for (const lang of asArray(record["LANGUAGENAME.LIST"])) {
    if (!isRecord(lang)) continue;
    for (const nl of asArray(lang["NAME.LIST"])) {
      if (isRecord(nl)) {
        const n = textOf(nl["NAME"]);
        if (n) return n;
      }
    }
  }
  return undefined;
}

/** Flatten one Tally object into UPPERCASE field -> text, including attributes (e.g. REMOTEID). */
export function flattenRecord(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === "#text") continue;
    if (k.startsWith("@_")) {
      if (typeof v === "string") out[k.slice(2).toUpperCase()] ??= v;
      continue;
    }
    const t = textOf(v);
    if (t !== undefined) out[k.toUpperCase()] = t;
  }
  const name = nameOf(record);
  if (name !== undefined) out["NAME"] = name;
  if (Object.keys(out).length === 0 && typeof record["#text"] === "string") out["VALUE"] = record["#text"];
  return out;
}

/**
 * Records from a collection export. Real TallyPrime responses nest objects as
 * ENVELOPE > BODY > DATA > COLLECTION > <LEDGER NAME="..."> (objectType = "Ledger").
 * Responses that repeat an element named after the collection id are also accepted.
 */
export function extractRecords(parsed: Record<string, unknown>, collectionId: string, objectType?: string): Array<Record<string, string>> {
  if (objectType) {
    const want = objectType.toUpperCase();
    const objects = findElements(parsed, (tag) => tag.toUpperCase() === want);
    if (objects.length > 0) return objects.map(flattenRecord);
  }
  const id = collectionId.toUpperCase();
  const byId = findElements(parsed, (tag) => tag.toUpperCase() === id);
  if (byId.length > 0) return byId.map(flattenRecord);
  return [];
}

/** Voucher objects from a Day Book (or any voucher) export, at any depth. */
export function extractDayBook(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  // A voucher record has child fields; a bare text value is never a voucher.
  const vouchers = findElements(parsed, (tag) => /^VOUCHER$/i.test(tag)).filter((v) => Object.keys(v).some((k) => k !== "#text"));
  if (vouchers.length > 0) return vouchers;
  return findElements(parsed, (tag) => /^DAYBOOK(\.LIST)?$/i.test(tag));
}

export interface RawImportResult {
  created: number;
  altered: number;
  deleted: number;
  voucherDeleted: number;
  cancelled: number;
  combined: number;
  ignored: number;
  /** ERRORS is a count in Tally's import response, not error text. */
  errors: number;
  exceptions: number;
  lastVchId?: string;
  lastMasterId?: string;
  lineErrors: string[];
}

const COUNTER_TAGS = ["CREATED", "ALTERED", "DELETED", "LASTVCHID", "LINEERROR", "EXCEPTIONS", "ERRORS", "COMBINED", "IGNORED"];

/**
 * Import response counters. Tally returns them under a RESPONSE root, or under
 * ENVELOPE > BODY > DATA > IMPORTRESULT; older builds use ENVELOPE > IMPORTDATA.
 */
export function extractImportResult(parsed: Record<string, unknown>): RawImportResult {
  const node = findCounterNode(parsed) ?? {};
  const num = (name: string): number => parseInt(textOf(node[name]) ?? "0", 10) || 0;
  const lastVch = textOf(node["LASTVCHID"]);
  const lastMid = textOf(node["LASTMID"]);
  return {
    created: num("CREATED"),
    altered: num("ALTERED"),
    deleted: num("DELETED"),
    voucherDeleted: num("VCHDEL"),
    cancelled: num("CANCELLED"),
    combined: num("COMBINED"),
    ignored: num("IGNORED"),
    errors: num("ERRORS"),
    exceptions: num("EXCEPTIONS"),
    lastVchId: lastVch && lastVch !== "0" ? lastVch : undefined,
    lastMasterId: lastMid && lastMid !== "0" ? lastMid : undefined,
    lineErrors: findElements(node, (tag) => tag.toUpperCase() === "LINEERROR")
      .map((e) => textOf(e) ?? "")
      .filter(Boolean)
  };
}

function findCounterNode(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findCounterNode(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (COUNTER_TAGS.some((t) => t in node)) return node;
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    const hit = findCounterNode(val);
    if (hit) return hit;
  }
  return null;
}

/**
 * Convert a Tally amount to this connector's convention: positive = debit, negative = credit.
 * Tally writes debits as negative numbers (and credits positive) in vouchers and masters;
 * formatted values may instead carry a "Dr"/"Cr" suffix.
 */
export function parseBalance(raw: unknown): number | undefined {
  const t = textOf(raw);
  if (t === undefined || t.trim() === "") return undefined;
  const s = t.replace(/,/g, "").trim();
  if (/\bDr\b/i.test(s)) return magnitude(s, 1);
  if (/\bCr\b/i.test(s)) return magnitude(s, -1);
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  if (Number.isNaN(n)) return undefined;
  return n === 0 ? 0 : -n;
}

function magnitude(s: string, sign: number): number | undefined {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return undefined;
  return sign * Math.abs(n);
}
