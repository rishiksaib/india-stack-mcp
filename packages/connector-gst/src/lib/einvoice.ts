import { ConnectorError, ErrorCode } from "@india-stack/core";
import { validateGstin } from "./gstin.js";

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
  quantity: number;
  unit?: string;
  unitPrice: number;
  taxRatePercent: number;
}

export interface EinvoiceDocInput {
  documentNumber: string;
  documentDate: string;
  supplyType?: "B2B" | "B2C" | "SEZ" | "EXP" | "DE";
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  items: EinvoiceItem[];
}

export interface EinvoicePayload {
  Version: string;
  TranDtls: { TaxScheme: "GST"; SupTyp: string };
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

const VALID_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 4, 5, 6, 7.5, 12, 18, 28]);

function toDdMmYyyy(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new ConnectorError(ErrorCode.ValidationError, `document date must be YYYY-MM-DD, got "${isoDate}"`);
  }
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function partyToDtls(party: EinvoiceParty): Record<string, unknown> {
  const info = validateGstin(party.gstin);
  if (!info.valid) {
    throw new ConnectorError(ErrorCode.ValidationError, `${party.gstin} is not a valid GSTIN`, { detail: { errors: info.errors } });
  }
  if (!/^\d{6}$/.test(party.pincode)) throw new ConnectorError(ErrorCode.ValidationError, `pincode must be 6 digits, got "${party.pincode}"`);
  return {
    Gstin: info.normalized,
    LglNm: party.legalName,
    Addr1: party.address,
    Loc: party.location,
    Pincode: Number.parseInt(party.pincode, 10),
    Stcd: party.stateCode,
    ...(party.email ? { Emal: party.email } : {}),
    ...(party.phone ? { Ph: party.phone } : {})
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildEinvoicePayload(input: EinvoiceDocInput): EinvoicePayload {
  if (!input.items.length) throw new ConnectorError(ErrorCode.ValidationError, "e-invoice needs at least one item");
  const supplyType = input.supplyType ?? "B2B";

  let assVal = 0;
  let cgstVal = 0;
  let sgstVal = 0;
  let igstVal = 0;

  const itemList = input.items.map((item, idx) => {
    if (!(item.quantity > 0)) throw new ConnectorError(ErrorCode.ValidationError, `item ${idx + 1}: quantity must be > 0`);
    if (!(item.unitPrice >= 0) || !Number.isFinite(item.unitPrice)) throw new ConnectorError(ErrorCode.ValidationError, `item ${idx + 1}: unit price must be a finite number >= 0`);
    if (!VALID_RATES.has(item.taxRatePercent)) {
      throw new ConnectorError(ErrorCode.ValidationError, `item ${idx + 1}: tax rate ${item.taxRatePercent}% is not a standard GST rate`, { detail: { allowed: [...VALID_RATES] } });
    }
    if (!/^\d{4,8}$/.test(item.hsnCode)) {
      throw new ConnectorError(ErrorCode.ValidationError, `item ${idx + 1}: HSN code must be 4-8 digits`);
    }
    const totAmt = round2(item.unitPrice * item.quantity);
    const assAmt = totAmt;
    let igst = 0;
    let cgst = 0;
    let sgst = 0;
    const taxAmt = round2((assAmt * item.taxRatePercent) / 100);
    const sellerState = input.seller.stateCode;
    const buyerState = input.buyer.stateCode;
    if (supplyType === "B2B" && sellerState === buyerState) {
      cgst = round2(taxAmt / 2);
      sgst = round2(taxAmt - cgst);
    } else {
      igst = taxAmt;
    }
    assVal += assAmt;
    cgstVal += cgst;
    sgstVal += sgst;
    igstVal += igst;
    return {
      SlNo: String(item.serialNo ?? idx + 1),
      ...(item.description ? { PrdDesc: item.description } : {}),
      HsnCd: item.hsnCode,
      Qty: round2(item.quantity),
      Unit: item.unit ?? "NOS",
      UnitPrice: round2(item.unitPrice),
      TotAmt: totAmt,
      AssAmt: assAmt,
      GstRt: item.taxRatePercent,
      IgstAmt: igst || undefined,
      CgstAmt: cgst || undefined,
      SgstAmt: sgst || undefined,
      TotItemVal: round2(assAmt + igst + cgst + sgst)
    };
  });

  const rawTotal = assVal + cgstVal + sgstVal + igstVal;
  const totInvVal = Math.round(rawTotal * 100) / 100;
  const rndOff = round2(totInvVal - rawTotal);

  return {
    Version: "1.01",
    TranDtls: { TaxScheme: "GST", SupTyp: supplyType },
    DocDtls: { Typ: "INV", No: input.documentNumber, Dt: toDdMmYyyy(input.documentDate) },
    SellerDtls: partyToDtls(input.seller),
    BuyerDtls: partyToDtls(input.buyer),
    ItemList: itemList.map((item) => {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item)) {
        if (v !== undefined) cleaned[k] = v;
      }
      return cleaned;
    }),
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
