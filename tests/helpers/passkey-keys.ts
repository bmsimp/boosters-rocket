import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A software authenticator over node:crypto (the sign-in release, slice SI-7a), with no database, so the browser spec
 * can import it too: a P-256 key pair; its public key as the passkey library stores it (the COSE EC2 key, CBOR written
 * by hand, standard base64 with padding as `base64.encode()` of @better-auth/utils writes it), and as base64url SPKI DER
 * and PKCS#8 for Playwright's `context.credentials.create()`; and an assertion for a challenge, as a browser's
 * `navigator.credentials.get()` answers through the passkey library's ceremony (`startAuthentication()`'s JSON, with
 * `clientExtensionResults` split off as the library's client does).
 */
export type PasskeyKey = {
  /** The credential's id, base64url, as the browser sends it and the library stores it. */
  id: string;
  /** The user handle the authenticator keeps with it, base64url. */
  userHandle: string;
  /** The public key as the library stores it (`parent_auth_passkey.public_key`). */
  publicKey: string;
  /** The same key as base64url SPKI DER, and the private key as base64url PKCS#8 DER, for Playwright. */
  spki: string;
  pkcs8: string;
  privateKey: KeyObject;
};

/** A CBOR byte string's head, for 32 bytes (major type 2, one-byte length). */
const bstr32 = (b: Buffer) => Buffer.concat([Buffer.from([0x58, 0x20]), b]);

/** A new passkey: a P-256 key pair, a random credential id and user handle. */
export function makePasskeyKey(): PasskeyKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  // The COSE key: a map of 5, kty (1) EC2 (2), alg (3) ES256 (-7), crv (-1) P-256 (1), x (-2), y (-3).
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), bstr32(x), Buffer.from([0x22]), bstr32(y)]);
  return {
    id: randomBytes(16).toString("base64url"),
    userHandle: randomBytes(16).toString("base64url"),
    publicKey: cose.toString("base64"),
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    pkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    privateKey,
  };
}

/** Flags of the authenticator data: user present (0x01) and user verified (0x04). */
export const PRESENT_AND_VERIFIED = 0x05;

export type AssertionJSON = {
  id: string; rawId: string; type: "public-key"; authenticatorAttachment?: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
};

/**
 * An assertion for `challenge` (the options' answer's, base64url), signed by `key`, as a browser answers: clientDataJSON
 * of type webauthn.get with the challenge and the origin; the authenticator data as the SHA-256 of the relying party id,
 * the flags and a four-byte counter; an ECDSA SHA-256 signature, DER, over the authenticator data and the SHA-256 of
 * clientDataJSON. The switches: other flags, another origin or relying party id, a counter, another key to sign with
 * (a forged signature, or another person's key under this credential id), and another credential id.
 */
export function assertionFor(key: PasskeyKey, challenge: string, o: { origin: string; rpId: string; flags?: number; counter?: number; signWith?: PasskeyKey; id?: string }): AssertionJSON {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin, crossOrigin: false }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(o.counter ?? 1);
  const authData = Buffer.concat([createHash("sha256").update(o.rpId).digest(), Buffer.from([o.flags ?? PRESENT_AND_VERIFIED]), counter]);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  const signature = sign("sha256", signed, { key: (o.signWith ?? key).privateKey, dsaEncoding: "der" });
  const id = o.id ?? key.id;
  return {
    id, rawId: id, type: "public-key", authenticatorAttachment: "platform",
    response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"), userHandle: key.userHandle },
  };
}

/** Flags of a registration's authenticator data: user present, user verified, and attested credential data (0x40). */
export const REGISTERED = 0x45;

export type RegistrationJSON = {
  id: string; rawId: string; type: "public-key"; authenticatorAttachment?: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

/** A CBOR head of a major type and a length, as far as two bytes of length. */
function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}
const cborText = (s: string) => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = (b: Buffer) => Buffer.concat([cborHead(2, b.length), b]);

/**
 * A registration answer for `challenge` (the registration options' answer's, base64url), for `key`, as a browser's
 * `navigator.credentials.create()` answers through the passkey library's ceremony (startRegistration()'s JSON, with
 * `clientExtensionResults` split off as its client does), with attestation `none` (the sign-in release, slice SI-7b):
 * clientDataJSON of type webauthn.create with the challenge and the origin, and an attestation object written by hand
 * in CBOR, `{ fmt: "none", attStmt: {}, authData }`, whose authenticator data is the SHA-256 of the relying party id,
 * the flags (user present, user verified and attested credential data unless told), a zero counter, and the attested
 * credential data: a zero AAGUID, the credential id's length and the id, and the COSE key as the library stores it.
 * The switches: other flags (0x41 for a passkey whose user wasn't verified), another origin or relying party id.
 */
export function registrationFor(key: PasskeyKey, challenge: string, o: { origin: string; rpId: string; flags?: number }): RegistrationJSON {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: o.origin, crossOrigin: false }));
  const credentialId = Buffer.from(key.id, "base64url");
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([createHash("sha256").update(o.rpId).digest(), Buffer.from([o.flags ?? REGISTERED]), Buffer.alloc(4),
    Buffer.alloc(16), idLength, credentialId, Buffer.from(key.publicKey, "base64")]);
  const attestation = Buffer.concat([cborHead(5, 3), cborText("fmt"), cborText("none"), cborText("attStmt"), cborHead(5, 0), cborText("authData"), cborBytes(authData)]);
  return {
    id: key.id, rawId: key.id, type: "public-key", authenticatorAttachment: "platform",
    response: { clientDataJSON: clientData.toString("base64url"), attestationObject: attestation.toString("base64url"), transports: ["internal", "hybrid"] },
  };
}
