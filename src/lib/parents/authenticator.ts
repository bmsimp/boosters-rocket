// A person's authenticator app and backup codes (the sign-in release, slice SI-6a; open questions 24, 25, 28 and 35 of
// the app-owned families spec): the only code that reads or writes `parent_authenticator` and `parent_backup_code`.
// The app's secret is sealed with the portal's own box (secretBox(), src/lib/crypto/secret-box.ts: AES-256-GCM under
// SETTINGS_ENCRYPTION_KEY, its key id beside it, SETTINGS_ENCRYPTION_KEY_PREVIOUS read while a key is replaced), as
// the QuickBooks tokens and the Documenso and mail secrets are, with an `aad` naming the table, the row and the person,
// so a sealed secret copied to another row or person doesn't open. Never BETTER_AUTH_SECRET: only the backup codes'
// keyed hash rides on that (backup-codes.ts). The secret is opened only inside the checks (takeAuthenticatorCode(), and
// since slice SI-6b confirmAuthenticator() at set-up), and is never logged, audited or thrown; it is answered once, as it
// is made (beginAuthenticatorSetup()), for the set-up's one answer to its own guardian (the key to type and the QR code
// drawn on the server, authenticator-settings.ts), and never again. A secret
// that won't open (SecretBoxError: the key replaced without its predecessor kept, or the row altered) is a refused try,
// never a throw. The check itself, with its limits, order and rows, is verifySecondFactor() (signin-codes.ts); this
// module takes a code for it inside the caller's transaction, where the caller writes the try's audit row. Server only.
import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parentAuthenticator, parentBackupCode } from "@/lib/db/schema";
import { SecretBoxError, secretBox, type SealedSecret } from "@/lib/crypto/secret-box";
import { base32Decode, base32Encode, matchTotp } from "./totp";
import { BACKUP_CODE_COUNT, hashBackupCode, newBackupCode, normalizeBackupCode, showBackupCode } from "./backup-codes";

/**
 * How long a set-up begun and never confirmed is kept (slice SI-6b begins one on the sign-in settings): half an hour is
 * far longer than scanning a code and typing one back takes. The daily clean-up deletes one older than this.
 */
export const AUTHENTICATOR_SETUP_LIFE_MS = 30 * 60 * 1000;

/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;

/** What binds a sealed secret to its row: the table, the row's id and the person. */
export const authenticatorAad = (id: string, parentId: string): string => `parent_authenticator:${id}:${parentId}`;

/** A secret (as base32, the form an app is given it in) sealed for its row and person. The row's id is chosen first. */
export const sealAuthenticatorSecret = (id: string, parentId: string, secretBase32: string): SealedSecret =>
  secretBox().seal(secretBase32, authenticatorAad(id, parentId));

/**
 * Whether the person has an authenticator app in force: a row of theirs whose set-up was confirmed. An unfinished
 * set-up is no second step. Read for every address at the door (a fixed nobody's too), so it costs the same either way.
 */
export async function hasAuthenticator(parentId: string, q: Reader = db): Promise<boolean> {
  const [row] = await q.select({ id: parentAuthenticator.id }).from(parentAuthenticator)
    .where(and(eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  return row !== undefined;
}

/**
 * When the person's app in force came into force (`confirmed_at`), or null with none: a session's proof older than this
 * no longer counts for asking again (sessionStrongAt(), asking-again.ts; slice SI-6b's second read).
 */
export async function authenticatorInForceSince(parentId: string, q: Reader = db): Promise<Date | null> {
  const [row] = await q.select({ since: parentAuthenticator.confirmedAt }).from(parentAuthenticator)
    .where(and(eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  return row?.since ?? null;
}

/** The person's app the sign-in took a code from is still there, theirs and in force (signinStands(), signin-codes.ts). */
export async function authenticatorStands(q: Reader, parentId: string, authenticatorId: string): Promise<boolean> {
  const [row] = await q.select({ id: parentAuthenticator.id }).from(parentAuthenticator)
    .where(and(eq(parentAuthenticator.id, authenticatorId), eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  return row !== undefined;
}

/** The backup code the sign-in spent is still there, the person's and spent (signinStands(), signin-codes.ts). */
export async function backupCodeStands(q: Reader, parentId: string, backupCodeId: string): Promise<boolean> {
  const [row] = await q.select({ id: parentBackupCode.id }).from(parentBackupCode)
    .where(and(eq(parentBackupCode.id, backupCodeId), eq(parentBackupCode.parentId, parentId), isNotNull(parentBackupCode.usedAt)));
  return row !== undefined;
}

/** Why a code wasn't taken, for the try's audit row only: no app in force, a secret that won't open, a wrong code, or one taken already. */
export type SecondStepMiss = "no_app" | "unreadable" | "wrong" | "replayed";

/**
 * An app's code, taken in the caller's transaction (which writes the try's audit row): the person's app in force, its
 * secret opened, the code matched for the step `now` falls in or the one before or after (matchTotp(), totp.ts), and
 * then taken only for a step newer than the newest one a code was taken for, by one conditional update (`last_used_step`
 * null or older, returning the row), so a code works once in its 30 seconds and two tries at once take it once. A
 * secret sealed under the key before SETTINGS_ENCRYPTION_KEY was changed is sealed again under the current key by that
 * same update: an app not used since a change still needs SETTINGS_ENCRYPTION_KEY_PREVIOUS (the runbooks say to keep it).
 */
export async function takeAuthenticatorCode(tx: Tx, parentId: string, code: string, now: Date): Promise<{ authenticatorId: string } | { miss: SecondStepMiss }> {
  const [row] = await tx.select({ id: parentAuthenticator.id, ciphertext: parentAuthenticator.secretCiphertext, keyId: parentAuthenticator.secretKeyId })
    .from(parentAuthenticator).where(and(eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  if (!row) return { miss: "no_app" };
  const box = secretBox();
  const aad = authenticatorAad(row.id, parentId);
  let opened: string;
  try {
    opened = box.open({ ciphertext: row.ciphertext, keyId: row.keyId }, aad);
  } catch (e) {
    if (e instanceof SecretBoxError) return { miss: "unreadable" };
    throw e;
  }
  const secret = base32Decode(opened);
  if (!secret || secret.length === 0) return { miss: "unreadable" };
  const step = matchTotp(secret, code, now);
  secret.fill(0);
  if (step === null) return { miss: "wrong" };
  // A secret sealed under a key since replaced (opened with SETTINGS_ENCRYPTION_KEY_PREVIOUS) is sealed again under the
  // current key as its code is taken, in the same update, so an app in use stops needing the old key.
  const resealed = row.keyId === box.currentKeyId ? null : box.seal(opened, aad);
  const [taken] = await tx.update(parentAuthenticator)
    .set(resealed ? { lastUsedStep: step, secretCiphertext: resealed.ciphertext, secretKeyId: resealed.keyId } : { lastUsedStep: step })
    .where(and(eq(parentAuthenticator.id, row.id), isNotNull(parentAuthenticator.confirmedAt),
      or(isNull(parentAuthenticator.lastUsedStep), lt(parentAuthenticator.lastUsedStep, step))))
    .returning({ id: parentAuthenticator.id });
  return taken ? { authenticatorId: taken.id } : { miss: "replayed" };
}

/**
 * A backup code, spent in the caller's transaction (which writes the try's audit row): a second step only beside an
 * app in force (until slice SI-7 makes them with a first passkey), read with normalizeBackupCode() and found by its
 * keyed hash among the person's unspent ones, spent by one conditional update (`used_at` null, returning the row), so
 * a code works once. Answers how many unspent are left.
 */
export async function takeBackupCode(tx: Tx, parentId: string, typed: string, now: Date): Promise<{ backupCodeId: string; left: number } | { miss: SecondStepMiss }> {
  if (!(await hasAuthenticator(parentId, tx))) return { miss: "no_app" };
  const code = normalizeBackupCode(typed);
  if (code === null) return { miss: "wrong" };
  const [spent] = await tx.update(parentBackupCode).set({ usedAt: now })
    .where(and(eq(parentBackupCode.parentId, parentId), eq(parentBackupCode.codeHash, hashBackupCode(parentId, code)), isNull(parentBackupCode.usedAt)))
    .returning({ id: parentBackupCode.id });
  if (!spent) return { miss: "wrong" };
  const [{ n }] = (await tx.select({ n: count() }).from(parentBackupCode)
    .where(and(eq(parentBackupCode.parentId, parentId), isNull(parentBackupCode.usedAt)))) as [{ n: number }];
  return { backupCodeId: spent.id, left: n };
}

/**
 * What the person's sign-in settings show of their app (slice SI-6b; loadMySignin(), signin-settings.ts): when the app
 * in force was confirmed, and how many unspent backup codes are left, or null with no app in force. Never the secret, a
 * row's id or a hash, and nothing of an unfinished set-up.
 */
export async function authenticatorShown(parentId: string, q: Reader = db): Promise<{ since: Date; backupCodesLeft: number } | null> {
  const [row] = await q.select({ since: parentAuthenticator.confirmedAt }).from(parentAuthenticator)
    .where(and(eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  if (!row?.since) return null;
  const [{ n }] = (await q.select({ n: count() }).from(parentBackupCode)
    .where(and(eq(parentBackupCode.parentId, parentId), isNull(parentBackupCode.usedAt)))) as [{ n: number }];
  return { since: row.since, backupCodesLeft: n };
}

/**
 * A set-up begun (slice SI-6b), in the caller's transaction, which holds the person's row and writes the audit row: with
 * no app in force, any unfinished set-up of the person is replaced by a new row (one per person,
 * `parent_authenticator_parent_uq`), its id chosen first, since the seal's `aad` names it, holding a new secret of 20
 * random bytes as base32, sealed (sealAuthenticatorSecret()); `confirmed_at` and `last_used_step` null, so nothing is in
 * force until a code from the app is checked (confirmAuthenticator()). Answers the new row's id (for the set-up's stamp
 * alone), the base32 secret, once, for the set-up's one answer (the key to type and the QR code), and how many
 * unfinished set-ups it replaced; null, changing nothing,
 * while an app is in force.
 */
export async function beginAuthenticatorSetup(tx: Tx, parentId: string, now: Date): Promise<{ id: string; secret: string; replaced: number } | null> {
  if (await hasAuthenticator(parentId, tx)) return null;
  const replaced = (await tx.delete(parentAuthenticator)
    .where(and(eq(parentAuthenticator.parentId, parentId), isNull(parentAuthenticator.confirmedAt))).returning({ id: parentAuthenticator.id })).length;
  const id = randomUUID();
  const bytes = randomBytes(20);
  const secret = base32Encode(bytes);
  bytes.fill(0);
  const sealed = sealAuthenticatorSecret(id, parentId, secret);
  await tx.insert(parentAuthenticator).values({ id, parentId, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, createdAt: now });
  return { id, secret, replaced };
}

/**
 * The person's one row (`parent_authenticator_parent_uq`) as it stands, for the set-up's stamp (authenticator-settings.ts,
 * since slice SI-6b's second read): its id, whether it is in force, and when it was begun, or null with none. Read for
 * the confirm alone, to tell its own set-up from one that replaced it or was finished; never shown, audited or sent.
 */
export async function authenticatorRowOf(parentId: string, q: Reader = db): Promise<{ id: string; inForce: boolean; createdAt: Date } | null> {
  const [row] = await q.select({ id: parentAuthenticator.id, confirmedAt: parentAuthenticator.confirmedAt, createdAt: parentAuthenticator.createdAt })
    .from(parentAuthenticator).where(eq(parentAuthenticator.parentId, parentId));
  return row ? { id: row.id, inForce: row.confirmedAt !== null, createdAt: row.createdAt } : null;
}

/** Why a set-up's code wasn't taken: no unfinished set-up younger than its life, a secret that won't open, or a wrong code. */
export type SetupMiss = "no_setup" | "unreadable" | "wrong";

/**
 * A set-up confirmed (slice SI-6b), in the caller's transaction, which holds the person's row and writes the audit row:
 * the person's unfinished set-up `setupId` (the one the confirm's stamp names), younger than AUTHENTICATOR_SETUP_LIFE_MS, its secret opened with its `aad`, and the
 * code typed (six digits, as readSecondStepCode() reads it) matched for the step `now` falls in or the one before or
 * after (matchTotp()); then one conditional update sets `confirmed_at` and `last_used_step` only while `confirmed_at`
 * is still null and the row within its life, returning it, so two confirms at once make one app and the code taken
 * here is never taken again at the door. A secret that won't open (SecretBoxError) is a miss, never a throw.
 */
export async function confirmAuthenticator(tx: Tx, parentId: string, setupId: string, code: string, now: Date): Promise<{ authenticatorId: string } | { miss: SetupMiss }> {
  const youngerThan = new Date(now.getTime() - AUTHENTICATOR_SETUP_LIFE_MS);
  const unfinished = and(eq(parentAuthenticator.id, setupId), eq(parentAuthenticator.parentId, parentId), isNull(parentAuthenticator.confirmedAt),
    gt(parentAuthenticator.createdAt, youngerThan));
  const [row] = await tx.select({ id: parentAuthenticator.id, ciphertext: parentAuthenticator.secretCiphertext, keyId: parentAuthenticator.secretKeyId })
    .from(parentAuthenticator).where(unfinished);
  if (!row) return { miss: "no_setup" };
  let opened: string;
  try {
    opened = secretBox().open({ ciphertext: row.ciphertext, keyId: row.keyId }, authenticatorAad(row.id, parentId));
  } catch (e) {
    if (e instanceof SecretBoxError) return { miss: "unreadable" };
    throw e;
  }
  const secret = base32Decode(opened);
  if (!secret || secret.length === 0) return { miss: "unreadable" };
  const step = matchTotp(secret, code, now);
  secret.fill(0);
  if (step === null) return { miss: "wrong" };
  const [taken] = await tx.update(parentAuthenticator).set({ confirmedAt: now, lastUsedStep: step })
    .where(and(eq(parentAuthenticator.id, row.id), unfinished)).returning({ id: parentAuthenticator.id });
  return taken ? { authenticatorId: taken.id } : { miss: "no_setup" };
}

/**
 * A new set of backup codes (slice SI-6b), in the caller's transaction, which holds the person's row and writes the
 * audit row: every backup code of the person deleted, spent or not, and BACKUP_CODE_COUNT new ones made by
 * newBackupCode(), stored only as their keyed hash (hashBackupCode()). Answers the codes as shown (showBackupCode()),
 * once, for the press's one answer, and how many it replaced. A sign-in that spent an old one just before is refused at
 * its last check (backupCodeStands(), `backup_code_gone`).
 */
export async function makeBackupCodes(tx: Tx, parentId: string, now: Date): Promise<{ codes: string[]; replaced: number }> {
  const replaced = (await tx.delete(parentBackupCode).where(eq(parentBackupCode.parentId, parentId)).returning({ id: parentBackupCode.id })).length;
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  await tx.insert(parentBackupCode).values(codes.map((code) => ({ parentId, codeHash: hashBackupCode(parentId, code), createdAt: now })));
  return { codes: codes.map(showBackupCode), replaced };
}

/**
 * The app turned off (slice SI-6b), in the caller's transaction, which holds the person's row and writes the audit row:
 * the person's `parent_authenticator` row (in force or unfinished) and every backup code of theirs deleted. A sign-in
 * whose app's code or backup code was taken just before is refused at its last check (authenticatorStands(),
 * backupCodeStands(): `second_factor_gone`, `backup_code_gone`). Answers how many of each went.
 */
export async function removeAuthenticator(tx: Tx, parentId: string): Promise<{ apps: number; backupCodes: number }> {
  const apps = (await tx.delete(parentAuthenticator).where(eq(parentAuthenticator.parentId, parentId)).returning({ id: parentAuthenticator.id })).length;
  const backupCodes = (await tx.delete(parentBackupCode).where(eq(parentBackupCode.parentId, parentId)).returning({ id: parentBackupCode.id })).length;
  return { apps, backupCodes };
}

/** What the daily clean-up deletes of these tables: an unfinished set-up older than its life, and a backup code spent longer ago than `spentKeptMs`. */
const setupGone = (now: Date) => and(isNull(parentAuthenticator.confirmedAt), lt(parentAuthenticator.createdAt, new Date(now.getTime() - AUTHENTICATOR_SETUP_LIFE_MS)));
const spentGone = (now: Date, spentKeptMs: number) => lt(parentBackupCode.usedAt, new Date(now.getTime() - spentKeptMs));

/** The people whose rows the clean-up will delete (cleanUp(), cleanup.ts, takes them FOR UPDATE in id order first). */
export const secondStepPeopleToClean = (tx: Tx, now: Date, spentKeptMs: number) => [
  tx.select({ id: parentAuthenticator.parentId }).from(parentAuthenticator).where(setupGone(now)),
  tx.select({ id: parentBackupCode.parentId }).from(parentBackupCode).where(spentGone(now, spentKeptMs)),
] as const;

/**
 * The clean-up's deletes here, inside its transaction, after it has taken the people's rows: an unfinished set-up
 * older than AUTHENTICATOR_SETUP_LIFE_MS (an app in force is never deleted by age), and a backup code spent longer ago
 * than `spentKeptMs` (a code's life, CODE_TTL_MS: the sign-in that spent it reads it again at its last check). An
 * unspent backup code never expires.
 */
export async function cleanUpSecondSteps(tx: Tx, now: Date, spentKeptMs: number): Promise<{ unfinishedSetups: number; spentBackupCodes: number }> {
  const unfinishedSetups = (await tx.delete(parentAuthenticator).where(setupGone(now)).returning({ id: parentAuthenticator.id })).length;
  const spentBackupCodes = (await tx.delete(parentBackupCode).where(spentGone(now, spentKeptMs)).returning({ id: parentBackupCode.id })).length;
  return { unfinishedSetups, spentBackupCodes };
}
