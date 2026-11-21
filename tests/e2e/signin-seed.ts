import { createHmac } from "node:crypto";

/**
 * What scripts/seed-e2e.ts seeds for the parent door of the sign-in release's slice SI-3b: a password for each seeded
 * parent (Zelda, and Ana, who is invited), kept as Better Auth's sign-up keeps one (the `credential` row of
 * `parent_auth_account`, hashed with better-auth/crypto's hashPassword()), and one remembered device for Zelda, with a
 * fixed token, so a spec can send its cookie (tests/e2e/parent-sign-in.spec.ts). The device is stored as the portal
 * stores one (hashDeviceToken(), src/lib/parents/devices.ts: an HMAC-SHA256 keyed with BETTER_AUTH_SECRET over
 * `signin-device:<token>`). This is test tooling only: it works because the e2e run knows the test secret. A spec that
 * makes a device or changes a password puts the seed back as it found it (tests/e2e/signin-links.ts).
 */
export const E2E_SIGNIN = {
  /** Zelda's and Ana's password: long, random-looking and of no use anywhere else. */
  password: "e2e parents' password, plum tractor lantern 4417",
  /** Zelda's remembered device: a token of a device token's shape (43 base64url characters), fixed so titles never change. */
  zeldaDevice: "e2e-zelda-remembered-device".padEnd(43, "0"),
} as const;

/** The device cookie's name and path, as parent-signin-step.ts sets it on an http APP_URL (no `__Secure-` prefix). */
export const DEVICE_COOKIE = { name: "br_parent.device", path: "/api/auth/parent" } as const;

/** How the portal stores a device token. */
export const deviceTokenHash = (token: string) => createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`signin-device:${token}`).digest("hex");
