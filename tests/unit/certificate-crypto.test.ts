import { describe, it, expect } from "vitest";
import { X509Certificate, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { generateCertificate, certificateDer, thumbprintsOf, CERTIFICATE_DAYS } from "@/lib/auth/certificate-crypto";

describe("generateCertificate", () => {
  it("makes a 2-year self-signed RSA 2048 certificate with matching thumbprints", async () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const g = await generateCertificate("Booster Rocket staff (portaltest.example.org)", now);
    const x = new X509Certificate(g.certificatePem);
    expect(x.subject).toBe("CN=Booster Rocket staff (portaltest.example.org)");
    expect(x.issuer).toBe(x.subject);
    expect(x.publicKey.asymmetricKeyType).toBe("rsa");
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(g.notAfter.toISOString()).toBe(new Date(now.getTime() + CERTIFICATE_DAYS * 86_400_000).toISOString());
    const der = certificateDer(g.certificatePem);
    expect(g.thumbprintS256).toBe(createHash("sha256").update(der).digest("base64url"));
    expect(g.thumbprintSha1).toBe(createHash("sha1").update(der).digest("hex").toUpperCase());
    expect(thumbprintsOf(der)).toEqual({ thumbprintS256: g.thumbprintS256, thumbprintSha1: g.thumbprintSha1 });
    // The private key belongs to the certificate.
    const pub = createPublicKey(createPrivateKey(g.privateKeyPem)).export({ type: "spki", format: "der" });
    expect(Buffer.compare(pub, x.publicKey.export({ type: "spki", format: "der" }))).toBe(0);
    expect(g.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("makes a different key every time", async () => {
    const [a, b] = await Promise.all([generateCertificate("A"), generateCertificate("A")]);
    expect(a.thumbprintS256).not.toBe(b.thumbprintS256);
  });
});
