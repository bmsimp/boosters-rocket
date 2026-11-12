import { describe, it, expect } from "vitest";
import { createSecretBox, SecretBoxError, keyIdOf } from "@/lib/crypto/secret-box";

const KEY_A = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const KEY_B = Buffer.from("previous-key-previous-key-prev!!").toString("base64");

describe("secret box", () => {
  it("round-trips a secret", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("s3cr3t~value", "staff-microsoft");
    expect(sealed.ciphertext).not.toContain("s3cr3t");
    expect(box.open(sealed, "staff-microsoft")).toBe("s3cr3t~value");
  });

  it("uses a fresh nonce every time", () => {
    const box = createSecretBox({ current: KEY_A });
    expect(box.seal("same", "k").ciphertext).not.toBe(box.seal("same", "k").ciphertext);
  });

  it("names the key by the first 8 hex of its SHA-256", () => {
    const box = createSecretBox({ current: KEY_A });
    expect(box.currentKeyId).toMatch(/^[0-9a-f]{8}$/);
    expect(box.seal("x", "k").keyId).toBe(keyIdOf(Buffer.from(KEY_A, "base64")));
  });

  it("refuses a tampered ciphertext", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "k");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[14] = raw[14]! ^ 0xff;
    expect(() => box.open({ ...sealed, ciphertext: raw.toString("base64") }, "k")).toThrow(SecretBoxError);
  });

  it("refuses a ciphertext moved to another row", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "staff-microsoft");
    expect(() => box.open(sealed, "mail:smtp-password")).toThrow(SecretBoxError);
  });

  it("refuses the wrong key", () => {
    const sealed = createSecretBox({ current: KEY_A }).seal("value", "k");
    expect(() => createSecretBox({ current: KEY_B }).open(sealed, "k")).toThrow(SecretBoxError);
  });

  it("still opens values sealed with the previous key", () => {
    const sealed = createSecretBox({ current: KEY_B }).seal("value", "k");
    const rotated = createSecretBox({ current: KEY_A, previous: KEY_B });
    expect(rotated.open(sealed, "k")).toBe("value");
    expect(rotated.seal("value", "k").keyId).toBe(rotated.currentKeyId);
  });

  it("refuses an unknown key id and a truncated value", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "k");
    expect(() => box.open({ ...sealed, keyId: "deadbeef" }, "k")).toThrow(SecretBoxError);
    expect(() => box.open({ ...sealed, ciphertext: "AAAA" }, "k")).toThrow(SecretBoxError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createSecretBox({ current: Buffer.from("short").toString("base64") })).toThrow(SecretBoxError);
  });
});
