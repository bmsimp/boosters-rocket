import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { jwtVerify, decodeProtectedHeader } from "jose";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { signEntraAssertion, createEntraAssertionGetter } from "@/lib/auth/client-assertion";

const TOKEN = "https://login.microsoftonline.com/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token";
const CLIENT = "11111111-2222-3333-4444-555555555555";

describe("Entra client assertion", () => {
  it("has the header and claims Microsoft requires, and verifies with the certificate", async () => {
    const g = await generateCertificate("test");
    const now = 1_800_000_000_000;
    const jwt = await signEntraAssertion({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT, tokenEndpoint: TOKEN, now });
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "PS256", typ: "JWT", "x5t#S256": g.thumbprintS256 });
    const { payload } = await jwtVerify(jwt, new X509Certificate(g.certificatePem).publicKey, {
      algorithms: ["PS256"], audience: TOKEN, issuer: CLIENT, subject: CLIENT, currentDate: new Date(now + 1000),
    });
    expect(payload.nbf).toBe(now / 1000);
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + 300);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives every assertion its own jti", async () => {
    const g = await generateCertificate("test");
    const get = createEntraAssertionGetter({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT });
    const [a, b] = await Promise.all([get({ clientId: CLIENT, tokenEndpoint: TOKEN, grantType: "authorization_code" }), get({ clientId: CLIENT, tokenEndpoint: TOKEN, grantType: "authorization_code" })]);
    const jti = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).jti;
    expect(jti(a)).not.toBe(jti(b));
  });

  it("uses the token endpoint Better Auth passes as the audience", async () => {
    const g = await generateCertificate("test");
    const get = createEntraAssertionGetter({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT });
    const other = "https://fznparents.ciamlogin.com/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token";
    const jwt = await get({ clientId: CLIENT, tokenEndpoint: other, grantType: "refresh_token" });
    expect(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).aud).toBe(other);
  });
});
