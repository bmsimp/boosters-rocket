// How the portal signs its requests to Boosters Rocket Connect, the relay: the relay's own format exactly (its
// SPEC.md section 4 and src/sign.ts, `signedHeaders()` and `newPortalKey()`), on Node's WebCrypto, with no library.
// The signature is Ed25519, base64url, over
//   BRC1\n<METHOD>\n<path>\n<Unix seconds>\n<nonce>\n<SHA-256 of the body, hex>
// computed over the exact body bytes sent. The relay refuses a time more than 5 minutes from its own clock and a nonce
// it has seen. Staff and worker code only: the private key it is given is opened from qbo_relay just to sign.
import { createHash, randomBytes } from "node:crypto";

export const RELAY_SIGNATURE_VERSION = "BRC1";

/** Base64url without padding, as the relay writes keys and signatures. */
export const b64url = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

/** The string the portal signs: the version, the request line, the time, the nonce and the body's digest. */
export function canonical(verb: string, path: string, timestamp: string, nonce: string, body: string): string {
  return [RELAY_SIGNATURE_VERSION, verb.toUpperCase(), path, timestamp, nonce, createHash("sha256").update(body, "utf8").digest("hex")].join("\n");
}

/** A fresh nonce: 18 random bytes, 24 URL-safe characters (the relay takes 16 to 64). */
export const newNonce = (): string => randomBytes(18).toString("base64url");

export type RelayHeaders = {
  "x-brc-portal": string; "x-brc-timestamp": string; "x-brc-nonce": string; "x-brc-signature": string; "content-type": "application/json";
};

/**
 * The headers of one signed request. `verb` is the request's HTTP verb, POST for every route the relay signs (named
 * so here, not `method`, since tests/unit/quickbooks-writes.test.ts reads every `method` as a request's). `now` and `nonce` are for tests: every real request takes the clock and a
 * fresh nonce.
 */
export async function signedHeaders(o: { portalId: string; privateKey: CryptoKey; verb: string; path: string; body: string; now?: Date; nonce?: string }): Promise<RelayHeaders> {
  const timestamp = String(Math.floor((o.now ?? new Date()).getTime() / 1000));
  const nonce = o.nonce ?? newNonce();
  const message = new TextEncoder().encode(canonical(o.verb, o.path, timestamp, nonce, o.body));
  const signature = b64url(await crypto.subtle.sign({ name: "Ed25519" }, o.privateKey, message));
  return { "x-brc-portal": o.portalId, "x-brc-timestamp": timestamp, "x-brc-nonce": nonce, "x-brc-signature": signature, "content-type": "application/json" };
}

/**
 * A new key pair. `publicKey` is the base64url of the 32 raw bytes, as the relay registers it (43 characters);
 * `privateKeyPkcs8` is the private key's PKCS#8 DER in base64, for the caller to seal at once (secretBox(), under
 * `qbo:relay-key`) and never to show, return, log or audit.
 */
export async function newRelayKey(): Promise<{ publicKey: string; privateKeyPkcs8: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKeyPkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return { publicKey, privateKeyPkcs8 };
}

/** The signing key from its sealed-and-opened PKCS#8 (base64). Not extractable: once imported, it only signs. */
export async function importRelayKey(privateKeyPkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", Buffer.from(privateKeyPkcs8, "base64"), { name: "Ed25519" }, false, ["sign"]);
}
