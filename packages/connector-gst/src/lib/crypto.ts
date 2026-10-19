/**
 * Generic RSA + AES-256-CBC + HMAC envelope helpers. This is NOT the NIC IRP wire format
 * (the IRP generate call takes {"Data": <payload encrypted with the session key from the auth
 * call>}); it is kept as a library utility only and is not used by any tool.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";

export interface NicEnvelope {
  Data: string;
  DataHash: string;
  Sek: string;
  meta: { cipher: "aes-256-cbc"; hmac: "sha256"; rsa: "pkcs1-v1_5"; sekBytes: number };
}

export function generateSek(): Buffer {
  return randomBytes(32);
}

function aesEncrypt(plaintext: Buffer, sek: Buffer): Buffer {
  const iv = sek.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", sek, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecrypt(ciphertext: Buffer, sek: Buffer): Buffer {
  const iv = sek.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", sek, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptForIrp(payloadJson: string, sellerPublicKeyPem: string, options?: { sek?: Buffer }): NicEnvelope {
  const sek = options?.sek ?? generateSek();
  const encryptedSek = publicEncrypt({ key: sellerPublicKeyPem, padding: 1 }, sek);
  const payload = Buffer.from(payloadJson, "utf8");
  const data = aesEncrypt(payload, sek);
  const hmac = createHmac("sha256", sek).update(payload).digest();
  return {
    Data: data.toString("base64"),
    DataHash: hmac.toString("base64"),
    Sek: encryptedSek.toString("base64"),
    meta: { cipher: "aes-256-cbc", hmac: "sha256", rsa: "pkcs1-v1_5", sekBytes: 32 }
  };
}

export interface DecryptedEnvelope {
  payloadJson: string;
  hmacValid: boolean;
}

export function decryptFromIrp(envelope: Pick<NicEnvelope, "Data" | "DataHash" | "Sek">, sellerPrivateKeyPem: string): DecryptedEnvelope {
  const sek = privateDecrypt({ key: sellerPrivateKeyPem, padding: 1 }, Buffer.from(envelope.Sek, "base64"));
  const payload = aesDecrypt(Buffer.from(envelope.Data, "base64"), sek);
  const expectedHmac = createHmac("sha256", sek).update(payload).digest();
  return {
    payloadJson: payload.toString("utf8"),
    hmacValid: expectedHmac.equals(Buffer.from(envelope.DataHash, "base64"))
  };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
