// Checks against e-invoice schema v1.1 (FORM GST INV-01) and the NIC JSON key names.
import { describe, expect, it } from "vitest";
import { buildEinvoicePayload, computeChecksum, reconcile2b, validateGstin } from "../src/index.js";

const gst = (base14: string) => base14 + computeChecksum(base14)!;
const seller = { gstin: gst("36BNZPM2501F1Z"), legalName: "Seller", address: "1 Road", location: "Hyderabad", pincode: "500001", stateCode: "36" };
const buyerSameState = { ...seller, gstin: gst("36AABCT3518Q1Z"), legalName: "Local Buyer" };
const buyerOtherState = { gstin: "27AAPFU0939F1ZV", legalName: "Pune Buyer", address: "2 Road", location: "Pune", pincode: "411001", stateCode: "27" };
const item = (over: Partial<{ hsnCode: string; quantity: number; unitPrice: number; taxRatePercent: number; isService: boolean }> = {}) => ({
  hsnCode: "8471",
  quantity: 2,
  unitPrice: 1000,
  taxRatePercent: 18,
  ...over
});

describe("e-invoice schema v1.1", () => {
  const p = buildEinvoicePayload({ documentNumber: "INV/1", documentDate: "2026-10-01", seller, buyer: buyerOtherState, items: [item(), item({ hsnCode: "998314", quantity: 1 })] });

  it("uses the schema's version and key names", () => {
    expect(p.Version).toBe("1.1");
    expect(p.TranDtls).toEqual({ TaxSch: "GST", SupTyp: "B2B", RegRev: "N" });
    expect(p.SellerDtls).toMatchObject({ Gstin: seller.gstin, Pin: 500001, Stcd: "36" });
    expect(p.SellerDtls).not.toHaveProperty("Pincode");
    expect(p.BuyerDtls).toMatchObject({ Pos: "27", Stcd: "27", Pin: 411001 });
  });

  it("marks every item with mandatory IsServc (SAC chapter 99 = service)", () => {
    expect(p.ItemList.map((i) => i.IsServc)).toEqual(["N", "Y"]);
  });

  it("splits by place of supply, not by the buyer's address", () => {
    const local = buildEinvoicePayload({ documentNumber: "I2", documentDate: "2026-10-01", seller, buyer: buyerSameState, items: [item()] });
    expect(local.ValDtls).toMatchObject({ CgstVal: 180, SgstVal: 180, IgstVal: 0, TotInvVal: 2360 });
    const shippedAway = buildEinvoicePayload({ documentNumber: "I3", documentDate: "2026-10-01", seller, buyer: buyerSameState, placeOfSupply: "27", items: [item()] });
    expect(shippedAway.ValDtls).toMatchObject({ CgstVal: 0, SgstVal: 0, IgstVal: 360 });
    expect(shippedAway.BuyerDtls.Pos).toBe("27");
  });

  it("accepts the 40% GST 2.0 slab", () => {
    const r = buildEinvoicePayload({ documentNumber: "I4", documentDate: "2026-10-01", seller, buyer: buyerOtherState, items: [item({ hsnCode: "2402", quantity: 1, unitPrice: 100, taxRatePercent: 40 })] });
    expect(r.ValDtls.IgstVal).toBe(40);
  });

  it("rejects a state code that contradicts the GSTIN", () => {
    expect(() =>
      buildEinvoicePayload({ documentNumber: "I5", documentDate: "2026-10-01", seller, buyer: { ...buyerOtherState, stateCode: "36" }, items: [item()] })
    ).toThrow(/does not match the GSTIN/);
  });

  it("rejects B2C (no IRN for B2C) and unknown supply codes", () => {
    expect(() =>
      buildEinvoicePayload({ documentNumber: "I6", documentDate: "2026-10-01", supplyType: "B2C" as never, seller, buyer: buyerOtherState, items: [item()] })
    ).toThrow(/not one of/);
  });

  it("handles exports: URP buyer, Pos 96, IGST with payment and zero tax without payment", () => {
    const buyer = { gstin: "URP", legalName: "Overseas Co", address: "1 Main St", location: "Dubai", pincode: "999999", stateCode: "96" };
    const wp = buildEinvoicePayload({ documentNumber: "E1", documentDate: "2026-10-01", supplyType: "EXPWP", seller, buyer, items: [item()] });
    expect(wp.BuyerDtls).toMatchObject({ Gstin: "URP", Pos: "96", Stcd: "96", Pin: 999999 });
    expect(wp.ValDtls.IgstVal).toBe(360);
    const wop = buildEinvoicePayload({ documentNumber: "E2", documentDate: "2026-10-01", supplyType: "EXPWOP", seller, buyer, items: [item()] });
    expect(wop.ValDtls).toMatchObject({ IgstVal: 0, TotInvVal: 2000 });
    expect(wop.ItemList[0]!.GstRt).toBe(18);
  });

  it("rounds to the rupee only when asked", () => {
    const items = [item({ quantity: 3, unitPrice: 333.33, taxRatePercent: 5 })];
    const plain = buildEinvoicePayload({ documentNumber: "R1", documentDate: "2026-10-01", seller, buyer: buyerOtherState, items });
    expect(plain.ValDtls).toMatchObject({ TotInvVal: 1049.99, RndOffAmt: 0 });
    const rounded = buildEinvoicePayload({ documentNumber: "R2", documentDate: "2026-10-01", seller, buyer: buyerOtherState, items, roundOff: true });
    expect(rounded.ValDtls).toMatchObject({ TotInvVal: 1050, RndOffAmt: 0.01 });
  });
});

describe("GSTIN labels", () => {
  it("labels PAN holder type P as an individual", () => {
    expect(validateGstin(gst("36BNZPM2501F1Z")).entityType).toMatch(/Individual/);
  });
});

describe("GSTR-2B reconciliation", () => {
  const g = "27AAPFU0939F1ZV";
  it("flags matched invoices whose ITC 2B marks as not available", () => {
    const r = reconcile2b(
      [{ gstin: g, invoiceNumber: "A1", taxableValue: 10000, igst: 1800 }],
      [{ gstin: g, invoiceNumber: "A1", taxableValue: 10000, igst: 1800, itcAvailable: false }]
    );
    expect(r.entries[0]).toMatchObject({ status: "matched_exact", itcUnavailable: true });
    expect(r.summary).toMatchObject({ itcUnavailable: 1, ineligibleItc: 1800 });
  });

  it("reconciles credit notes and cess, and never fuzzy-matches a note to an invoice", () => {
    const r = reconcile2b(
      [
        { gstin: g, invoiceNumber: "CN-1", taxableValue: -1000, igst: -180, cess: -10 },
        { gstin: g, invoiceNumber: "B7", date: "2026-09-02", taxableValue: 1000, igst: 180 }
      ],
      [
        { gstin: g, invoiceNumber: "CN-1", taxableValue: -1000, igst: -180, cess: -10 },
        { gstin: g, invoiceNumber: "Z9", invoiceDate: "2026-09-02", taxableValue: -1000, igst: -180 }
      ]
    );
    expect(r.summary.matchedExact).toBe(1);
    expect(r.summary.missingInBooks).toBe(1);
    expect(r.summary.missingIn2b).toBe(1);
  });
});
