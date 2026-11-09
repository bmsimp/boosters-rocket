import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/env";

export type SealedSecret = { ciphertext: string; keyId: string };
export type SecretBox = {
  currentKeyId: string;
  seal(plaintext: string, aad: string): SealedSecret;
  open(sealed: SealedSecret, aad: string): string;
};
export class SecretBoxError extends Error {}

const NONCE = 12;
const TAG = 16;

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function decodeKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new SecretBoxError("An encryption key must be 32 bytes, base64.");
  return key;
}

/** AES-256-GCM. The ciphertext is base64(nonce ‖ body ‖ tag); `aad` binds it to one row. */
export function createSecretBox(keys: { current: string; previous?: string }): SecretBox {
  const current = decodeKey(keys.current);
  const byId = new Map<string, Buffer>([[keyIdOf(current), current]]);
  if (keys.previous) {
    const previous = decodeKey(keys.previous);
    byId.set(keyIdOf(previous), previous);
  }
  return {
    currentKeyId: keyIdOf(current),
    seal(plaintext, aad) {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv("aes-256-gcm", current, nonce);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64"), keyId: keyIdOf(current) };
    },
    open({ ciphertext, keyId }, aad) {
      const key = byId.get(keyId);
      if (!key) throw new SecretBoxError(`No encryption key with id ${keyId}.`);
      const raw = Buffer.from(ciphertext, "base64");
      if (raw.length < NONCE + TAG) throw new SecretBoxError("The stored secret is too short to be valid.");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(raw.subarray(raw.length - TAG));
      try {
        return Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("The stored secret could not be decrypted.");
      }
    },
  };
}

let box: SecretBox | null = null;
/** The process-wide box, built from SETTINGS_ENCRYPTION_KEY (and _PREVIOUS while a key is being replaced). */
export function secretBox(): SecretBox {
  box ??= createSecretBox({ current: env.SETTINGS_ENCRYPTION_KEY, previous: env.SETTINGS_ENCRYPTION_KEY_PREVIOUS });
  return box;
}
