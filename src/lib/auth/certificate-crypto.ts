import "reflect-metadata"; // tsyringe (under @peculiar/x509) needs a Reflect polyfill loaded first
import { createHash, randomBytes, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const CERTIFICATE_DAYS = 730;
/** notBefore is backdated this much so a server whose clock runs slightly behind Microsoft's still accepts a new certificate. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export type GeneratedCertificate = { certificatePem: string; privateKeyPem: string; thumbprintS256: string; thumbprintSha1: string; notAfter: Date };

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;

const pem = (label: string, der: ArrayBuffer | Buffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der as ArrayBuffer).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

export function certificateDer(certificatePem: string): Buffer {
  return Buffer.from(certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""), "base64");
}

/** x5t#S256 (base64url SHA-256) for the assertion header; SHA-1 hex as the Entra admin center shows it. */
export function thumbprintsOf(der: Buffer): { thumbprintS256: string; thumbprintSha1: string } {
  return {
    thumbprintS256: createHash("sha256").update(der).digest("base64url"),
    thumbprintSha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
  };
}

/** A new RSA 2048 key and a self-signed certificate for it, valid from 5 minutes before `now` until CERTIFICATE_DAYS after it. */
export async function generateCertificate(commonName: string, now = new Date()): Promise<GeneratedCertificate> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const notAfter = new Date(now.getTime() + CERTIFICATE_DAYS * 86_400_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(15).toString("hex")}`, // leading 01 keeps the serial positive
    name: `CN=${commonName.replace(/[,+="\<>;]/g, " ")}`,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter,
    signingAlgorithm: ALG,
    keys: keys as unknown as CryptoKeyPair,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)],
  });
  const der = Buffer.from(cert.rawData);
  return {
    certificatePem: pem("CERTIFICATE", der),
    privateKeyPem: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)),
    notAfter,
    ...thumbprintsOf(der),
  };
}
