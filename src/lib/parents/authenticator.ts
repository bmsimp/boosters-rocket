// A person's authenticator app and backup codes (the sign-in release, slice SI-6a; open questions 24, 25, 28 and 35 of
// the app-owned families spec): the only code that reads or writes `parent_authenticator` and `parent_backup_code`.
// The app's secret is sealed with the portal's own box (secretBox(), src/lib/crypto/secret-box.ts: AES-256-GCM under
// SETTINGS_ENCRYPTION_KEY, its key id beside it, SETTINGS_ENCRYPTION_KEY_PREVIOUS read while a key is replaced), as
// the QuickBooks tokens and the Documenso and mail secrets are, with an `aad` naming the table, the row and the person,
// so a sealed secret copied to another row or person doesn't open. Never BETTER_AUTH_SECRET: only the backup codes'
// keyed hash rides on that (backup-codes.ts). The secret is opened only inside the check (takeAuthenticatorCode(); in
// SI-6b, once more to draw its set-up), and is never logged, audited, thrown, sent to the browser or answered. A secret
// that won't open (SecretBoxError: the key replaced without its predecessor kept, or the row altered) is a refused try,
// never a throw. The check itself, with its limits, order and rows, is verifySecondFactor() (signin-codes.ts); this
// module takes a code for it inside the caller's transaction, where the caller writes the try's audit row. Server only.
import "server-only";
import { and, count, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parentAuthenticator, parentBackupCode } from "@/lib/db/schema";
import { SecretBoxError, secretBox, type SealedSecret } from "@/lib/crypto/secret-box";
import { base32Decode, matchTotp } from "./totp";
import { hashBackupCode, normalizeBackupCode } from "./backup-codes";

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
 * null or older, returning the row), so a code works once in its 30 seconds and two tries at once take it once.
 */
export async function takeAuthenticatorCode(tx: Tx, parentId: string, code: string, now: Date): Promise<{ authenticatorId: string } | { miss: SecondStepMiss }> {
  const [row] = await tx.select({ id: parentAuthenticator.id, ciphertext: parentAuthenticator.secretCiphertext, keyId: parentAuthenticator.secretKeyId })
    .from(parentAuthenticator).where(and(eq(parentAuthenticator.parentId, parentId), isNotNull(parentAuthenticator.confirmedAt)));
  if (!row) return { miss: "no_app" };
  let secret: Buffer | null;
  try {
    secret = base32Decode(secretBox().open({ ciphertext: row.ciphertext, keyId: row.keyId }, authenticatorAad(row.id, parentId)));
  } catch (e) {
    if (e instanceof SecretBoxError) return { miss: "unreadable" };
    throw e;
  }
  if (!secret || secret.length === 0) return { miss: "unreadable" };
  const step = matchTotp(secret, code, now);
  secret.fill(0);
  if (step === null) return { miss: "wrong" };
  const [taken] = await tx.update(parentAuthenticator).set({ lastUsedStep: step })
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
