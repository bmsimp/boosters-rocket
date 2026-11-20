import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthenticator, parentBackupCode } from "@/lib/db/schema";
import { sealAuthenticatorSecret } from "@/lib/parents/authenticator";
import { base32Decode, base32Encode, hotp, totpStep } from "@/lib/parents/totp";
import { BACKUP_CODE_COUNT, hashBackupCode, newBackupCode, showBackupCode } from "@/lib/parents/backup-codes";

/**
 * A person's authenticator app and backup codes in a test (the sign-in release, slice SI-6a): seeded as the set-up
 * stores them since SI-6b (beginAuthenticatorSetup(), confirmAuthenticator(), makeBackupCodes()): a 20-byte secret
 * sealed by the portal's own box for its row and person (sealAuthenticatorSecret()), and backup codes held only as
 * their keyed hash. A test of the set-up itself goes through its presses (tests/integration/authenticator-settings.test.ts).
 */

/**
 * An app for the person: in force (`confirmed_at` set) unless `confirmed` is false (a set-up never finished), with
 * `lastUsedStep` when a code was taken before. Its row's id and the base32 secret, which only the test holds, to work
 * out its codes with appCode(). An app in force is set up an hour before now unless `createdAt` says when, so a proof a
 * test stamps just now (proveRecently()) is newer than the app and counts beside it (a proof made before the app came
 * into force doesn't: proofCountsBesideApp(), slice SI-6b's second read); an unfinished set-up is begun now, within its life.
 */
export async function seedAuthenticator(parentId: string, o: { confirmed?: boolean; lastUsedStep?: number | null; createdAt?: Date } = {}): Promise<{ id: string; secret: string }> {
  const id = randomUUID();
  const secret = base32Encode(randomBytes(20));
  const sealed = sealAuthenticatorSecret(id, parentId, secret);
  const at = o.createdAt ?? (o.confirmed === false ? new Date() : new Date(Date.now() - 60 * 60_000));
  await db.insert(parentAuthenticator).values({ id, parentId, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, createdAt: at,
    confirmedAt: o.confirmed === false ? null : at, lastUsedStep: o.lastUsedStep ?? null });
  return { id, secret };
}

/** The app's code for the step `at` falls in, or `steps` steps from it (negative before), as the app on the parent's phone shows it. */
export function appCode(secret: string, at: Date | number = Date.now(), steps = 0): string {
  return hotp(base32Decode(secret)!, totpStep(at) + steps);
}

/** A six-digit code that is none of the app's codes for the steps around `at`: a wrong try, whatever the secret. */
export function wrongAppCode(secret: string, at: Date | number = Date.now()): string {
  const near = new Set([-2, -1, 0, 1, 2].map((s) => appCode(secret, at, s)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!near.has(code)) return code;
  }
}

/** Backup codes for the person, held as SI-6b will hold them: their keyed hashes alone. The codes as shown (with their dash). */
export async function seedBackupCodes(parentId: string, n = BACKUP_CODE_COUNT): Promise<string[]> {
  const codes = Array.from({ length: n }, () => newBackupCode());
  await db.insert(parentBackupCode).values(codes.map((code) => ({ parentId, codeHash: hashBackupCode(parentId, code) })));
  return codes.map(showBackupCode);
}

/** The person's app rows, and backup code rows. */
export const authenticatorRows = (parentId: string) => db.select().from(parentAuthenticator).where(eq(parentAuthenticator.parentId, parentId));
export const backupCodeRows = (parentId: string) => db.select().from(parentBackupCode).where(eq(parentBackupCode.parentId, parentId));
