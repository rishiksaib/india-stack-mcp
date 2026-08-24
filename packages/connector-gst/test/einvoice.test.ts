import { describe, expect, it } from "vitest";
import { ConnectorError, ErrorCode } from "@india-stack/core";
import { buildEinvoicePayload } from "../src/lib/einvoice.js";

const seller = {
  gstin: "27AAPFU0939F1ZV",
  legalName: "Acme Traders Pvt Ltd",
  address: "12 MG Road",
  location: "Pune",
  pincode: "411001",
  stateCode: "27"
};

const buyerInterstate = { ...seller, gstin: "29AAACR5055K1Z3", legalName: "Karnataka Buyer", location: "Bengaluru", pincode: "560001", stateCode: "29" };

const baseItems = [
  { description: "Widget", hsnCode: "8479", quantity: 10, unitPrice: 1000, taxRatePercent: 18 },
  { hsnCode: "998314", quantity: 1, unitPrice: 500.25, taxRatePercent: 18 }
];

describe("e-invoice payload builder", () => {
  it("splits IGST for interstate supply and computes totals with round-off", () => {
    const payload = buildEinvoicePayload({
      documentNumber: "INV/24-25/001",
      documentDate: "2024-04-05",
      seller,
      buyer: buyerInterstate,
      items: baseItems
    });

    expect(payload.TranDtls.SupTyp).toBe("B2B");
    expect(payload.DocDtls).toEqual({ Typ: "INV", No: "INV/24-25/001", Dt: "05/04/2024" });
    expect(payload.SellerDtls.Gstin).toBe("27AAPFU0939F1ZV");

    const item0 = payload.ItemList[0]!;
    expect(item0.TotAmt).toBe(10000);
    expect(item0.AssAmt).toBe(10000);
    expect(item0.IgstAmt).toBe(1800);
    expect(item0.CgstAmt).toBeUndefined();

    const item1 = payload.ItemList[1]!;
    expect(item1.TotAmt).toBe(500.25);
    expect(item1.IgstAmt).toBe(90.05);

    const v = payload.ValDtls;
    expect(v.AssVal).toBe(10500.25);
    expect(v.IgstVal).toBe(1890.05);
    expect(v.CgstVal).toBe(0);
    expect(v.SgstVal).toBe(0);
    expect(v.RndOffAmt + v.AssVal + v.IgstVal).toBeCloseTo(v.TotInvVal, 2);
  });

  it("splits CGST+SGST halves for intrastate B2B supply", () => {
    const buyer = { ...seller, legalName: "Local Buyer" };
    const payload = buildEinvoicePayload({ documentNumber: "INV-2", documentDate: "2024-04-05", seller, buyer, items: [baseItems[0]!] });
    expect(payload.ItemList[0]!.CgstAmt).toBe(900);
    expect(payload.ItemList[0]!.SgstAmt).toBe(900);
    expect(payload.ValDtls.CgstVal).toBe(900);
    expect(payload.ValDtls.SgstVal).toBe(900);
  });

  it("rejects invalid GSTINs on either party", () => {
    const badBuyer = { ...buyerInterstate, gstin: "27INVALIDGSTIN1" };
    expect(() =>
      buildEinvoicePayload({ documentNumber: "X", documentDate: "2024-04-05", seller, buyer: badBuyer as typeof buyerInterstate, items: baseItems })
    ).toThrowError(ConnectorError);
  });

  it("rejects non-standard GST rates and bad HSN codes", () => {
    expect(() =>
      buildEinvoicePayload({ documentNumber: "X", documentDate: "2024-04-05", seller, buyer: buyerInterstate, items: [{ ...baseItems[0]!, taxRatePercent: 11 }] })
    ).toThrowError(/standard GST rate/);
    expect(() =>
      buildEinvoicePayload({ documentNumber: "X", documentDate: "2024-04-05", seller, buyer: buyerInterstate, items: [{ ...baseItems[0]!, hsnCode: "12" }] })
    ).toThrowError(/HSN/);
  });

  it("rejects empty item lists and bad dates", () => {
    try {
      buildEinvoicePayload({ documentNumber: "X", documentDate: "2024-04-05", seller, buyer: buyerInterstate, items: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConnectorError).code).toBe(ErrorCode.ValidationError);
    }
    expect(() =>
      buildEinvoicePayload({ documentNumber: "X", documentDate: "05-04-2024", seller, buyer: buyerInterstate, items: baseItems })
    ).toThrowError(/YYYY-MM-DD/);
  });
});
