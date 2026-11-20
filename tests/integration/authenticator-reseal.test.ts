import { describe, it, expect, vi, beforeEach } from "vitest";

// The portal's box as it is while SETTINGS_ENCRYPTION_KEY is being replaced: a new current key, and the tests' own key
// (the one every other test file seals under) kept as SETTINGS_ENCRYPTION_KEY_PREVIOUS. Its own file, so no other test
// meets this box.
const NEXT_KEY = vi.hoisted(() => Buffer.alloc(32, 7).toString("base64"));
vi.mock("@/lib/crypto/secret-box", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/secret-box")>();
  const { env } = await import("@/env");
  const box = actual.createSecretBox({ current: NEXT_KEY, previous: env.SETTINGS_ENCRYPTION_KEY });
  return { ...actual, secretBox: () => box };
});

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthenticator } from "@/lib/db/schema";
import { createSecretBox, keyIdOf } from "@/lib/crypto/secret-box";
import { authenticatorAad } from "@/lib/parents/authenticator";
import { verifySecondFactor } from "@/lib/parents/signin-codes";
import { base32Encode } from "@/lib/parents/totp";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardianInFamily } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, stepPersonFor } from "../helpers/parent-door";
import { seedPassword } from "../helpers/signin-links";
import { appCode, wrongAppCode } from "../helpers/authenticator";

/**
 * An authenticator app sealed under the key before SETTINGS_ENCRYPTION_KEY was changed (the sign-in release, slice
 * SI-6a): it opens while the old key is kept as SETTINGS_ENCRYPTION_KEY_PREVIOUS, and the code it takes seals it again
 * under the current key, so once it has been used it no longer needs the old key.
 */
const nextKeyId = keyIdOf(Buffer.from(NEXT_KEY, "base64"));
const appRow = async (id: string) => (await db.select().from(parentAuthenticator).where(eq(parentAuthenticator.id, id)))[0]!;

beforeEach(async () => { await resetDb(); await seedParentSettings(SIGNINS_ON); });

/** Ana, with the helper's password and an app in force sealed under the old key alone. */
async function anaWithAnOldSeal() {
  const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
  await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
  await seedPassword(ana.authUserId, DOOR_PASSWORD);
  const id = randomUUID();
  const secret = base32Encode(randomBytes(20));
  const sealed = createSecretBox({ current: env.SETTINGS_ENCRYPTION_KEY }).seal(secret, authenticatorAad(id, ana.id));
  const at = new Date();
  await db.insert(parentAuthenticator).values({ id, parentId: ana.id, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, createdAt: at, confirmedAt: at });
  return { ...ana, app: { id, secret, oldKeyId: sealed.keyId } };
}

describe("an app sealed under the key before a change", () => {
  it("is sealed again under the current key when its code is taken, and then opens with the current key alone", async () => {
    const ana = await anaWithAnOldSeal();
    expect(ana.app.oldKeyId).not.toBe(nextKeyId);
    const now = new Date();
    const r = await verifySecondFactor(await stepPersonFor("ana@example.com"), appCode(ana.app.secret, now), DOOR_IP, now);
    expect(r.ok).toBe(true);
    const row = await appRow(ana.app.id);
    expect(row.secretKeyId).toBe(nextKeyId);
    // The current key alone opens it now, for its own row and person.
    expect(createSecretBox({ current: NEXT_KEY }).open({ ciphertext: row.secretCiphertext, keyId: row.secretKeyId }, authenticatorAad(ana.app.id, ana.id)))
      .toBe(ana.app.secret);
  });

  it("is left as it was by a wrong try", async () => {
    const ana = await anaWithAnOldSeal();
    const before = await appRow(ana.app.id);
    const now = new Date();
    const r = await verifySecondFactor(await stepPersonFor("ana@example.com"), wrongAppCode(ana.app.secret, now), DOOR_IP, now);
    expect(r).toEqual({ ok: false, reason: "rejected", ended: false });
    const after = await appRow(ana.app.id);
    expect([after.secretKeyId, after.secretCiphertext, after.lastUsedStep]).toEqual([before.secretKeyId, before.secretCiphertext, null]);
  });
});
