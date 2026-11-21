// Backup codes (the sign-in release, slice SI-6a; open question 25 of the app-owned families spec): ten codes, each
// working once as a second step in place of the authenticator app (and, from slice SI-7, a passkey). This module is
// the one place their form is defined, so the maker (SI-6b, which shows them once) and the check
// (verifySecondFactor(), signin-codes.ts) can't disagree: the alphabet, the shape, the reading of what a parent types,
// and the keyed hash, the only form the database holds (`parent_backup_code.code_hash`, through authenticator.ts).
import { createHmac, randomInt } from "node:crypto";
import { env } from "@/env";

/**
 * The characters a backup code is made of: the capital letters and digits with the ones easily read as another left
 * out (no I, O, 0 or 1), 32 in all, so a code of ten carries 50 bits.
 */
export const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** How many characters a backup code has. */
export const BACKUP_CODE_LENGTH = 10;
/** How many codes a guardian is given at a time. */
export const BACKUP_CODE_COUNT = 10;

const SHAPE = new RegExp(`^[${BACKUP_CODE_ALPHABET}]{5}-?[${BACKUP_CODE_ALPHABET}]{5}$`);

/**
 * A typed backup code as the portal holds it, or null when it isn't one: spaces anywhere are dropped and the letters
 * read in any case, then it must be ten characters of the alphabet, with or without the dash it is shown with between
 * its two halves. The answer is the ten characters alone, upper case.
 */
export function normalizeBackupCode(typed: string): string | null {
  const v = typed.replace(/\s+/g, "").toUpperCase();
  return SHAPE.test(v) ? v.replace("-", "") : null;
}

/** Whether what was typed is a backup code's shape (normalizeBackupCode() reads it as one). */
export const isBackupCodeShape = (typed: string): boolean => normalizeBackupCode(typed) !== null;

/**
 * What a typed second step is by its shape (verifySecondFactor(), signin-codes.ts): with spaces and dashes dropped
 * first (an app shows its code as "123 456", and some as "123-456"), six digits are an authenticator app's code, kept as
 * typed (a leading zero included); ten characters of the alphabet, in any case, a backup code, as
 * normalizeBackupCode() reads it; anything else is neither.
 */
export type TypedSecondStep = { kind: "app"; code: string } | { kind: "backup"; code: string } | { kind: "neither" };
export function readSecondStepCode(raw: string): TypedSecondStep {
  const typed = raw.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(typed)) return { kind: "app", code: typed };
  const backup = normalizeBackupCode(typed);
  return backup !== null ? { kind: "backup", code: backup } : { kind: "neither" };
}

/** A code as it is shown: its two halves with a dash between them. */
export const showBackupCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

/** A new backup code: ten characters of the alphabet, each drawn at random. */
export function newBackupCode(): string {
  let out = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) out += BACKUP_CODE_ALPHABET[randomInt(0, BACKUP_CODE_ALPHABET.length)];
  return out;
}

/**
 * The one form of a backup code the database holds: an HMAC-SHA256 keyed with the server secret over a string that
 * names its purpose, the person and the code as normalizeBackupCode() reads it, as a sign-in code is hashed
 * (hashSigninCode(), signin-codes.ts), so a copy of the database alone can't be searched for a code, and one person's
 * code is never found as another's.
 */
export const hashBackupCode = (parentId: string, code: string): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`backup-code:${parentId}:${code}`).digest("hex");
