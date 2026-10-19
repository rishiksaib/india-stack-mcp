import { ConnectorError, ErrorCode } from "@india-stack/core";
import { GST_STATE_CODES, validateGstin } from "./gstin.js";

// Builds the e-invoice JSON in the shape of schema version 1.1 (FORM GST INV-01,
// notified by Notification 60/2020-Central Tax).

export interface EinvoiceParty {
  gstin: string;
  legalName: string;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
  email?: string;
  phone?: string;
}

export interface EinvoiceItem {
  serialNo?: number;
  description?: string;
  hsnCode: string;
  /** Defaults from the HSN/SAC code: chapter 99 (SAC) = service. */
  isService?: boolean;
  quantity: number;
  unit?: string;
  unitPrice: number;
  taxRatePercent: number;
}

/** Supply type codes from the schema. B2C is not accepted: IRNs are not generated for B2C. */
export type SupplyType = "B2B" | "SEZWP" | "SEZWOP" | "EXPWP" | "EXPWOP" | "DEXP";
export const SUPPLY_TYPES: SupplyType[] = ["B2B", "SEZWP", "SEZWOP", "EXPWP", "EXPWOP", "DEXP"];

export interface EinvoiceDocInput {
  documentNumber: string;
  documentDate: string;
  documentType?: "INV" | "CRN" | "DBN";
  supplyType?: SupplyType;
  /** 2-digit state code of the place of supply; defaults to the buyer's state (96 for exports). */
  placeOfSupply?: string;
  reverseCharge?: boolean;
  /** Round the invoice total to the nearest rupee and record the difference in RndOffAmt. */
  roundOff?: boolean;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  items: EinvoiceItem[];
}

export interface EinvoicePayload {
  Version: "1.1";
  TranDtls: { TaxSch: "GST"; SupTyp: SupplyType; RegRev: "Y" | "N" };
  DocDtls: { Typ: string; No: string; Dt: string };
  SellerDtls: Record<string, unknown>;
  BuyerDtls: Record<string, unknown>;
  ItemList: Array<Record<string, unknown>>;
  ValDtls: {
    AssVal: number;
    CgstVal: number;
    SgstVal: number;
    IgstVal: number;
    RndOffAmt: number;
    TotInvVal: number;
  };
}

/** GST rates in force. 40% is the GST 2.0 rate effective 22 Sep 2025; 12/28 still appear on older documents. */
export const VALID_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

const EXPORT_TYPES = new Set<SupplyType>(["EXPWP", "EXPWOP"]);
const WITHOUT_PAYMENT = new Set<SupplyType>(["SEZWOP", "EXPWOP"]);
const ALWAYS_IGST = new Set<SupplyType>(["SEZWP", "SEZWOP", "EXPWP", "EXPWOP"]);

function fail(message: string, detail?: Record<string, unknown>): never {
  throw new ConnectorError(ErrorCode.ValidationError, message, detail ? { detail } : undefined);
}

function toDdMmYyyy(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) fail(`document date must be YYYY-MM-DD, got "${isoDate}"`);
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function partyToDtls(party: EinvoiceParty, role: "seller" | "buyer", supplyType: SupplyType): Record<string, unknown> {
  const isExportBuyer = role === "buyer" && EXPORT_TYPES.has(supplyType);
  if (isExportBuyer && party.gstin.trim().toUpperCase() === "URP") {
    return {
      Gstin: "URP",
      LglNm: party.legalName,
      Addr1: party.address,
      Loc: party.location,
      Pin: 999999,
      Stcd: "96",
      ...(party.email ? { Em: party.email } : {}),
      ...(party.phone ? { Ph: party.phone } : {})
    };
  }
  const info = validateGstin(party.gstin);
  if (!info.valid) fail(`${role} GSTIN ${party.gstin} is not valid`, { errors: info.errors });
  if (!/^\d{6}$/.test(party.pincode)) fail(`${role} pincode must be 6 digits, got "${party.pincode}"`);
  if (party.stateCode !== info.stateCode) {
    fail(`${role} state_code ${party.stateCode} does not match the GSTIN, which is registered in state ${info.stateCode} (${info.stateName})`);
  }
  return {
    Gstin: info.normalized,
    LglNm: party.legalName,
    Addr1: party.address,
    Loc: party.location,
    Pin: Number.parseInt(party.pincode, 10),
    Stcd: party.stateCode,
    ...(party.email ? { Em: party.email } : {}),
    ...(party.phone ? { Ph: party.phone } : {})
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildEinvoicePayload(input: EinvoiceDocInput): EinvoicePayload {
  if (!input.items.length) fail("e-invoice needs at least one item");
  const supplyType: SupplyType = input.supplyType ?? "B2B";
  if (!SUPPLY_TYPES.includes(supplyType)) {
    fail(`supply type "${supplyType}" is not one of ${SUPPLY_TYPES.join(", ")} (IRNs are not generated for B2C)`);
  }

  const seller = partyToDtls(input.seller, "seller", supplyType);
  const buyer = partyToDtls(input.buyer, "buyer", supplyType);
  const pos = input.placeOfSupply ?? (EXPORT_TYPES.has(supplyType) ? "96" : String(buyer.Stcd));
  if (!/^\d{2}$/.test(pos) || (pos !== "96" && !GST_STATE_CODES[pos])) fail(`place of supply "${pos}" is not a valid 2-digit state code`);
  const intraState = !ALWAYS_IGST.has(supplyType) && String(seller.Stcd) === pos;
  const taxPaid = !WITHOUT_PAYMENT.has(supplyType);

  let assVal = 0;
  let cgstVal = 0;
  let sgstVal = 0;
  let igstVal = 0;

  const itemList = input.items.map((item, idx) => {
    const n = idx + 1;
    if (!(item.quantity > 0)) fail(`item ${n}: quantity must be > 0`);
    if (!(item.unitPrice >= 0) || !Number.isFinite(item.unitPrice)) fail(`item ${n}: unit price must be a finite number >= 0`);
    if (!VALID_RATES.has(item.taxRatePercent)) fail(`item ${n}: tax rate ${item.taxRatePercent}% is not a GST rate`, { allowed: [...VALID_RATES] });
    if (!/^\d{4,8}$/.test(item.hsnCode)) fail(`item ${n}: HSN/SAC code must be 4-8 digits`);
    const isService = item.isService ?? item.hsnCode.startsWith("99");
    const totAmt = round2(item.unitPrice * item.quantity);
    const assAmt = totAmt;
    const taxAmt = taxPaid ? round2((assAmt * item.taxRatePercent) / 100) : 0;
    let igst = 0;
    let cgst = 0;
    let sgst = 0;
    if (intraState) {
      cgst = round2(taxAmt / 2);
      sgst = round2(taxAmt - cgst);
    } else {
      igst = taxAmt;
    }
    assVal += assAmt;
    cgstVal += cgst;
    sgstVal += sgst;
    igstVal += igst;
    const row: Record<string, unknown> = {
      SlNo: String(item.serialNo ?? n),
      ...(item.description ? { PrdDesc: item.description } : {}),
      IsServc: isService ? "Y" : "N",
      HsnCd: item.hsnCode,
      Qty: round2(item.quantity),
      Unit: item.unit ?? (isService ? "OTH" : "NOS"),
      UnitPrice: round2(item.unitPrice),
      TotAmt: totAmt,
      AssAmt: assAmt,
      GstRt: item.taxRatePercent,
      IgstAmt: igst,
      CgstAmt: cgst,
      SgstAmt: sgst,
      TotItemVal: round2(assAmt + igst + cgst + sgst)
    };
    return row;
  });

  const rawTotal = round2(assVal + cgstVal + sgstVal + igstVal);
  const totInvVal = input.roundOff ? Math.round(rawTotal) : rawTotal;
  const rndOff = round2(totInvVal - rawTotal);

  return {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: supplyType, RegRev: input.reverseCharge ? "Y" : "N" },
    DocDtls: { Typ: input.documentType ?? "INV", No: input.documentNumber, Dt: toDdMmYyyy(input.documentDate) },
    SellerDtls: seller,
    BuyerDtls: { ...buyer, Pos: pos },
    ItemList: itemList,
    ValDtls: {
      AssVal: round2(assVal),
      CgstVal: round2(cgstVal),
      SgstVal: round2(sgstVal),
      IgstVal: round2(igstVal),
      RndOffAmt: rndOff,
      TotInvVal: totInvVal
    }
  };
}
