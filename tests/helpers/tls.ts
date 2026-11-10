import "reflect-metadata"; // tsyringe (under @peculiar/x509) needs a Reflect polyfill loaded first
import { webcrypto, randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** A self-signed certificate for 127.0.0.1 and localhost, valid a week: for local TLS stubs only. */
export async function localhostCertificate(): Promise<{ key: string; cert: string }> {
  const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(8).toString("hex")}`, name: "CN=localhost",
    notBefore: new Date(now - 60_000), notAfter: new Date(now + 7 * 86_400_000),
    signingAlgorithm: alg, keys: keys as unknown as CryptoKeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment | x509.KeyUsageFlags.keyCertSign, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }, { type: "ip", value: "127.0.0.1" }]),
    ],
  });
  return { cert: cert.toString("pem"), key: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)) };
}
