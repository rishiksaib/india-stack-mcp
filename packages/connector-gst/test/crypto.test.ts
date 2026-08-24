import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEinvoicePayload } from "../src/lib/einvoice.js";
import { decryptFromIrp, encryptForIrp } from "../src/lib/crypto.js";

const seller = {
  gstin: "27AAPFU0939F1ZV",
  legalName: "Acme Traders Pvt Ltd",
  address: "12 MG Road",
  location: "Pune",
  pincode: "411001",
  stateCode: "27"
};
const buyer = { ...seller, gstin: "29AAACR5055K1Z3", legalName: "Karnataka Buyer", location: "Bengaluru", pincode: "560001", stateCode: "29" };

describe("NIC-style IRP envelope crypto", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("roundtrips payload through encryption and decryption with valid HMAC", () => {
    const payloadJson = JSON.stringify(
      buildEinvoicePayload({
        documentNumber: "INV-CRYPTO-1",
        documentDate: "2024-04-05",
        seller,
        buyer,
        items: [{ hsnCode: "8479", quantity: 2, unitPrice: 5000, taxRatePercent: 18 }]
      })
    );

    const sek = encryptForIrp(payloadJson, publicKeyPem).meta.sekBytes === 32 ? undefined : undefined;
    void sek;

    const envelope = encryptForIrp(payloadJson, publicKeyPem);
    expect(envelope.Data).not.toContain("INV-CRYPTO-1");
    expect(envelope.Sek).not.toBe("");
    expect(envelope.meta.cipher).toBe("aes-256-cbc");

    const decrypted = decryptFromIrp(envelope, privateKeyPem);
    expect(decrypted.hmacValid).toBe(true);
    expect(JSON.parse(decrypted.payloadJson)).toEqual(JSON.parse(payloadJson));
  });

  it("produces different ciphertexts for the same payload across runs (random SEK)", () => {
    const json = '{"hello":"world"}';
    const a = encryptForIrp(json, publicKeyPem);
    const b = encryptForIrp(json, publicKeyPem);
    expect(a.Data).not.toEqual(b.Data);
    expect(a.Sek).not.toEqual(b.Sek);
  });

  it("fails HMAC verification when the payload is tampered after signing", () => {
    const json = '{"v":1}';
    const envelope = encryptForIrp(json, publicKeyPem);
    const tampered = { ...envelope, DataHash: Buffer.from("tampered-hash").toString("base64") };
    const decrypted = decryptFromIrp(tampered, privateKeyPem);
    expect(decrypted.payloadJson).toBe(json);
    expect(decrypted.hmacValid).toBe(false);
  });

  it("supports deterministic SEK injection for reproducible envelopes", () => {
    const sek = Buffer.alloc(32, 7);
    const envelope = encryptForIrp('{"a":1}', publicKeyPem, { sek });
    const decrypted = decryptFromIrp(envelope, privateKeyPem);
    expect(decrypted.payloadJson).toBe('{"a":1}');
    expect(decrypted.hmacValid).toBe(true);
  });
});
