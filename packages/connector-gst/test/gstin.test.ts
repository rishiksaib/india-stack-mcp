import { describe, expect, it } from "vitest";
import { computeChecksum, validateGstin } from "../src/lib/gstin.js";

describe("GSTIN validation", () => {
  it("accepts the canonical valid sample", () => {
    const info = validateGstin("27AAPFU0939F1ZV");
    expect(info.valid).toBe(true);
    expect(info.stateCode).toBe("27");
    expect(info.stateName).toBe("Maharashtra");
    expect(info.pan).toBe("AAPFU0939F");
  });

  it("normalizes whitespace and case before validating", () => {
    expect(validateGstin(" 27aapfu0939f1zv ").valid).toBe(true);
    expect(validateGstin("27-AAPFU-0939F1ZV").valid).toBe(true);
  });

  it("detects a wrong checksum character", () => {
    const info = validateGstin("27AAPFU0939F1ZW");
    expect(info.valid).toBe(false);
    expect(info.errors[0]).toContain('should be "V"');
  });

  it("rejects malformed inputs with format errors", () => {
    expect(validateGstin("").valid).toBe(false);
    expect(validateGstin("27AAPFU0939F1").valid).toBe(false);
    expect(validateGstin("XXAAPFU0939F1ZV").valid).toBe(false);
    const tooLong = validateGstin("27AAPFU0939F1ZVV");
    expect(tooLong.valid).toBe(false);
  });

  it("flags unknown state codes", () => {
    const info = validateGstin("99AAPFU0939F1ZV");
    expect(info.valid).toBe(false);
    expect(info.errors.some((e) => e.includes("state code"))).toBe(true);
  });

  it("computes the expected checksum for a constructed GSTIN", () => {
    const base = "29AAACR5055K1Z";
    const check = computeChecksum(base);
    expect(check).toMatch(/^[0-9A-Z]$/);
    expect(validateGstin(base + check).valid).toBe(true);
  });

  it("extracts entity type from the PAN character", () => {
    expect(validateGstin("27AAPFU0939F1ZV").entityType).toBe("Partnership Firm");
    expect(validateGstin("27PAPFU0939F1ZV".slice(0, 2) + "AAPPU0939P" + "1ZV").entityType).toContain("Proprietorship");
  });
});
