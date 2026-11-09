import { createPrivateKey, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** thumbprintS256 and thumbprintSha1Base64Url are base64url digests of the certificate's DER (x5t#S256 and x5t). */
export type AssertionKey = { privateKeyPem: string; thumbprintS256: string; thumbprintSha1Base64Url: string };
/** Structurally Better Auth's ClientAssertionGetter (which this app can't import directly under pnpm's strict layout). */
export type AssertionGetter = (ctx: { clientId: string; tokenEndpoint: string; grantType: string }) => Promise<string>;

const LIFETIME_SECONDS = 300;

/** Microsoft's certificate credential assertion (private_key_jwt): PS256, x5t#S256 and x5t headers, 5-minute life. */
export async function signEntraAssertion(o: AssertionKey & { clientId: string; tokenEndpoint: string; now?: number }): Promise<string> {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "PS256", typ: "JWT", "x5t#S256": o.thumbprintS256, x5t: o.thumbprintSha1Base64Url })
    .setIssuer(o.clientId)
    .setSubject(o.clientId)
    .setAudience(o.tokenEndpoint)
    .setJti(randomUUID())
    .setNotBefore(now)
    .setIssuedAt(now)
    .setExpirationTime(now + LIFETIME_SECONDS)
    .sign(createPrivateKey(o.privateKeyPem));
}

export function createEntraAssertionGetter(o: AssertionKey & { clientId: string }): AssertionGetter {
  return ({ tokenEndpoint }) => signEntraAssertion({ ...o, tokenEndpoint });
}
