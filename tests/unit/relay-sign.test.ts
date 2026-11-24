import { describe, it, expect } from "vitest";
import { canonical, importRelayKey, newNonce, newRelayKey, signedHeaders } from "@/lib/quickbooks/relay-sign";

/**
 * A vector made on 2026-11-24 with the relay repository's own signer (bmsimp/boosters-rocket-connect, src/sign.ts
 * `signedHeaders()` and src/crypto.ts `canonical()`), from a key made there for this test alone and registered nowhere.
 * Ed25519 is deterministic, so the same key, time, nonce and body must give this signature here too.
 */
const VECTOR = {
  publicKey: "gbltJgDOnRxjmYnR45vZLQksg_FU67qiHffLEm4zqcY",
  pkcs8: "MC4CAQAwBQYDK2VwBCIEIC+C6DHug0TFO0/pY4/0Jl8vAB9GWjpgfUbxklzqBgVG",
  portalId: "brp_0123456789abcdef",
  path: "/v1/connect/start",
  body: "{\"environment\":\"sandbox\",\"portal_state\":\"portal-state-0123456789abcdef\"}",
  now: new Date("2026-11-24T12:00:00Z"),
  nonce: "fixed-nonce-0123456789abcdef",
  canonical: "BRC1\nPOST\n/v1/connect/start\n1795521600\nfixed-nonce-0123456789abcdef\ne77acab4d41daf19ad44cc369175bd19da51da89577773b9d8b1a8d905c6db52",
  headers: {
    "x-brc-portal": "brp_0123456789abcdef",
    "x-brc-timestamp": "1795521600",
    "x-brc-nonce": "fixed-nonce-0123456789abcdef",
    "x-brc-signature": "sJNCZLnfh47xFaXQYbL16yyTERSpoKo6auBUJjvwtofdeG1XsHd36XkkdH9ea6mcFf1Nke3uW2l_-uA__awEAQ",
    "content-type": "application/json",
  },
};

const verify = async (publicKey: string, message: string, signature: string) => {
  const key = await crypto.subtle.importKey("raw", Buffer.from(publicKey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(message));
};
const signVector = async (over: Partial<{ method: string; path: string; body: string }> = {}) => signedHeaders({
  portalId: VECTOR.portalId, privateKey: await importRelayKey(VECTOR.pkcs8), verb: over.method ?? "POST", path: over.path ?? VECTOR.path,
  body: over.body ?? VECTOR.body, now: VECTOR.now, nonce: VECTOR.nonce,
});

describe("the relay's request signature", () => {
  it("is the relay's own format: the version, the method, the path, Unix seconds, the nonce and the body's SHA-256", () => {
    expect(canonical("POST", VECTOR.path, VECTOR.headers["x-brc-timestamp"], VECTOR.nonce, VECTOR.body)).toBe(VECTOR.canonical);
    expect(canonical("post", VECTOR.path, "1", "n", "")).toBe("BRC1\nPOST\n/v1/connect/start\n1\nn\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("gives, for the vector's key, time, nonce and body, the headers the relay's signer gave", async () => {
    expect(await signVector()).toEqual(VECTOR.headers);
    expect(await verify(VECTOR.publicKey, VECTOR.canonical, VECTOR.headers["x-brc-signature"])).toBe(true);
  });

  it("fails the relay's check when one byte of the body, the path or the method differs from what was signed", async () => {
    const { "x-brc-signature": signature } = await signVector();
    const changedBody = VECTOR.body.replace("sandbox", "sandbax");
    expect(await verify(VECTOR.publicKey, canonical("POST", VECTOR.path, VECTOR.headers["x-brc-timestamp"], VECTOR.nonce, changedBody), signature)).toBe(false);
    expect(await verify(VECTOR.publicKey, canonical("POST", "/v1/token/refresh", VECTOR.headers["x-brc-timestamp"], VECTOR.nonce, VECTOR.body), signature)).toBe(false);
    expect(await verify(VECTOR.publicKey, canonical("PUT", VECTOR.path, VECTOR.headers["x-brc-timestamp"], VECTOR.nonce, VECTOR.body), signature)).toBe(false);
  });

  it("takes the clock and a fresh nonce of 24 URL-safe characters when none is given", async () => {
    const before = Math.floor(Date.now() / 1000);
    const a = await signedHeaders({ portalId: VECTOR.portalId, privateKey: await importRelayKey(VECTOR.pkcs8), verb: "POST", path: VECTOR.path, body: "{}" });
    const b = await signedHeaders({ portalId: VECTOR.portalId, privateKey: await importRelayKey(VECTOR.pkcs8), verb: "POST", path: VECTOR.path, body: "{}" });
    expect(Number(a["x-brc-timestamp"])).toBeGreaterThanOrEqual(before);
    expect(Number(a["x-brc-timestamp"])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(a["x-brc-nonce"]).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a["x-brc-nonce"]).not.toBe(b["x-brc-nonce"]);
    expect(newNonce()).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe("the portal's key", () => {
  it("is a new Ed25519 pair each time: the public half as the relay registers it, the private half PKCS#8 that signs", async () => {
    const a = await newRelayKey(), b = await newRelayKey();
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKeyPkcs8).not.toBe(b.privateKeyPkcs8);
    expect(Buffer.from(a.privateKeyPkcs8, "base64")).toHaveLength(48);
    const h = await signedHeaders({ portalId: VECTOR.portalId, privateKey: await importRelayKey(a.privateKeyPkcs8), verb: "POST", path: "/v1/token/refresh", body: "{}", now: VECTOR.now, nonce: VECTOR.nonce });
    const message = canonical("POST", "/v1/token/refresh", h["x-brc-timestamp"], VECTOR.nonce, "{}");
    expect(await verify(a.publicKey, message, h["x-brc-signature"])).toBe(true);
    expect(await verify(b.publicKey, message, h["x-brc-signature"])).toBe(false);
  });

  it("once imported, only signs: it can't be exported again", async () => {
    const key = await importRelayKey(VECTOR.pkcs8);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
  });
});
