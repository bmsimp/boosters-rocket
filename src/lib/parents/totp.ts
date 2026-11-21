// The time-based code of an authenticator app (the sign-in release, slice SI-6a; open questions 24 and 35 of the
// app-owned families spec): the portal's own, over node:crypto alone, as the standards define it. RFC 4648 base32 (the
// form an app is given the secret in), RFC 4226 HOTP (HMAC-SHA1 with dynamic truncation) and RFC 6238 TOTP (30-second
// steps counted from the Unix epoch). The portal asks for 6 digits everywhere; the number of digits is an argument only
// so the standards' published values, given at 8, can be checked (tests/unit/totp.test.ts). Pure: no clock, no
// database, no secret of the portal's; the caller passes the time and the person's secret.
import { createHmac, timingSafeEqual } from "node:crypto";

/** RFC 4648 section 6: the base32 alphabet. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The length of one time step, in seconds (RFC 6238's default, which every authenticator app uses). */
export const TOTP_STEP_SECONDS = 30;
/** The digits of a code the portal asks for. */
export const TOTP_DIGITS = 6;

/** Bytes as RFC 4648 base32, upper case, with no padding (as an app's set-up takes a secret). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only the bits not yet written, so `value` never grows past a byte and a half
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * RFC 4648 base32 back to bytes, or null for text that isn't base32. Padding ("=") at the end is allowed and ignored,
 * and so is lower case; anything else outside the alphabet is not base32.
 */
export function base32Decode(text: string): Buffer | null {
  const body = text.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of body) {
    const at = ALPHABET.indexOf(ch);
    if (at < 0) return null;
    value = (value << 5) | at;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** RFC 4226: the HOTP value of the secret at the counter, as `digits` digits (leading zeros kept). */
export function hotp(secret: Uint8Array, counter: number | bigint, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(message).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const binary = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step a moment falls in (RFC 6238: whole steps of TOTP_STEP_SECONDS since the Unix epoch). `at` in milliseconds or a Date. */
export function totpStep(at: Date | number): number {
  const ms = typeof at === "number" ? at : at.getTime();
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 6238: the code of the secret for the step `at` falls in. */
export function totp(secret: Uint8Array, at: Date | number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(at), digits);
}

/**
 * Which step a typed code is the secret's code for: the step before the one `at` falls in, that step, or the step
 * after (a clock one step off either way, and no wider), or null. A code of any other shape than `digits` digits is
 * null at once. The three are worked out and compared in constant time each, all three always, so the time taken
 * doesn't tell which matched. When more than one matches (two steps with the same code), the newest is answered.
 */
export function matchTotp(secret: Uint8Array, typed: string, at: Date | number, digits = TOTP_DIGITS): number | null {
  if (!new RegExp(`^\\d{${digits}}$`).test(typed)) return null;
  const got = Buffer.from(typed, "utf8");
  const now = totpStep(at);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (step < 0) continue;
    const want = Buffer.from(hotp(secret, step, digits), "utf8");
    if (timingSafeEqual(want, got)) matched = step;
  }
  return matched;
}
