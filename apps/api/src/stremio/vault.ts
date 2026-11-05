import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { StremioIntegrationError } from "./types.js";

export interface EncryptedValue {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export class StremioVault {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("Stremio vault key must contain 32 bytes");
    this.#key = Buffer.from(key);
  }

  encrypt(value: string, context: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    };
  }

  decrypt(value: EncryptedValue, context: string): string {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        Buffer.from(value.iv, "base64")
      );
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new StremioIntegrationError("INVALID_RESPONSE");
    }
  }
}
