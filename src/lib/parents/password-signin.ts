// Signing in with a password (the sign-in release, slice SI-3b; section 6 of the app-owned families spec, "Signing in",
// and its Appendix A): the first step of every sign-in at /sign-in, reached only through the parent code plugin's
// /portal-password/check (src/lib/auth/parent-code-plugin.ts). The portal checks the password itself against the
// person's `credential` row of `parent_auth_account` (verifyPassword() from better-auth/crypto); Better Auth's own
// password routes stay shut (emailAndPassword off, PARENT_DISABLED_PATHS). Server only.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { takeRateLimit, type RateLimitTake } from "./rate-limit";
import { enterableGuardianRows, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed } from "./settings";
import { takeIpLimit, type PasswordProof } from "./signin-codes";
import { rememberedDevice } from "./devices";
import { secondStepFor } from "./second-step-rule";

/** The most an address field may hold as sent, as on the request page (password-request.ts). */
export const MOST_TYPED_ADDRESS = 320;
/** The most a password field may hold as sent, as on a link's form (MOST_SENT, password-set.ts). */
export const MOST_TYPED_PASSWORD = 1024;

/**
 * The key a per-address count of password tries is kept under: an HMAC-SHA256 keyed with the server secret over a
 * string that names its purpose, as the request page's (hashAskedAddress(), password-request.ts), so no
 * `rate_limit_event` row holds an address, an outsider's least of all.
 */
export const hashTriedAddress = (address: string): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`password-try:${address}`).digest("hex");

/** No person has this id: the rows of an address nobody holds are read for it, so every try makes the same reads. */
const NOBODY = "00000000-0000-0000-0000-000000000000";
/** Who tried, when the address is nobody's: no id, no label, and never the address typed. */
const ANON: Actor = { door: "parent", id: null, label: null };

/**
 * A hash of a random password nobody knows, made once per process: an address with no person, or a person with no
 * password, is checked against it, so the time of a refusal doesn't tell an address on file from one that isn't (as
 * Better Auth's own sign-in route hashes a password for an unknown address).
 */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(32).toString("base64url")));

/** Why a password signs nobody in, for the audit row only. */
export type PasswordRefusal = "rate_limited" | "not_an_address" | "signins_off" | "unknown_email" | "no_sign_in_account" | "no_password"
  | "wrong_password" | "blocked" | "no_enabled_guardian" | "strict_no_factor";

/**
 * A right password: the person, the address it was proved with (as the portal holds it), the `credential` row it was
 * checked against, and the remembered device the request's device cookie names for this person, or null (none,
 * expired, forgotten, another person's), when the second step is to be asked. Every refusal is the one `{ ok: false }`.
 */
export type PasswordCheck = { ok: true; person: { id: string; email: string }; password: PasswordProof; device: { deviceId: string } | null } | { ok: false };
const REFUSED: PasswordCheck = { ok: false };

type Found = { id: string; email: string; blocked: boolean; authUserId: string | null; credentialId: string | null; hash: string | null; updatedAt: Date | null };

/** The person who holds the address, with their sign-in account and their `credential` row (id, hash, `updated_at`). */
async function personWithPassword(email: string | null): Promise<Found | null> {
  if (!email) return null;
  const [row] = await db.select({
    id: parent.id, email: parent.email, blocked: parent.blocked, authUserId: parentAuthUser.id,
    credentialId: parentAuthAccount.id, hash: parentAuthAccount.password,
    // Read through sql<Date>: drizzle's inferred type of this column of the Better Auth tables comes out as never (schema.ts).
    updatedAt: sql<Date | null>`${parentAuthAccount.updatedAt}`.mapWith(parentAuthAccount.updatedAt),
  }).from(parent)
    .leftJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id))
    .leftJoin(parentAuthAccount, and(eq(parentAuthAccount.userId, parentAuthUser.id), eq(parentAuthAccount.providerId, "credential")))
    .where(eq(parent.email, email));
  return row ?? null;
}

/** One refusal's row: against the person when the address is theirs, otherwise naming nobody. A wrong password is its own action. */
async function audit(reason: PasswordRefusal, who: { id: string; email: string } | null, ip: string | null, extra: Record<string, unknown> = {}) {
  await writeAudit({
    actor: who ? parentActor(who) : ANON, action: reason === "wrong_password" ? "signin.password_wrong" : "signin.password_refused",
    targetType: who ? "parent" : undefined, targetId: who?.id, after: reason === "wrong_password" ? {} : { reason, ...extra }, ip,
  });
}

/**
 * The password step, in this order (each argument comes from the browser but the device token, which is the request's
 * own device cookie, read by src/lib/auth/parent-signin-step.ts):
 * (a) the arguments: an address of at most MOST_TYPED_ADDRESS characters and a password of at most MOST_TYPED_PASSWORD;
 *     anything else is the refusal, uncounted and unrecorded;
 * (b) the limit per IP address (`password_try_ip`; skipped when the address is unknown: every visitor would share one count);
 * (c) the address, read with normalizeEmail(), and the limit per address (`password_try_email`), counted under
 *     hashTriedAddress(), never the address (what was typed, lower-cased, when it is no address), whatever it names, and
 *     not counted while the IP address is over its limit;
 * (d) the reads, the same whoever the address names: the parents' settings (the door and the level), the person by
 *     address with their sign-in account and their `credential` row, and their rows that count (read for a fixed
 *     nobody when the address is nobody's);
 * (e) verifyPassword() against the row's hash, or, with no person or no password, against a fixed dummy hash, outside
 *     any transaction, so the time doesn't tell;
 * (f) the verdict, in this order of reasons: over a limit, not an address, sign-ins off, nobody's address, no sign-in
 *     account, no password, a wrong password (`signin.password_wrong`), blocked, no row that counts, and the second step
 *     the club's level asks for (secondStepFor(): under Strict, nothing with no second factor, `strict_no_factor`, on a
 *     remembered device too, which proved only the mailbox). Each is audited once, in its own write
 *     (`signin.password_refused` with its reason, and for over a limit, `limit`, once per full window, naming nobody);
 * (g) for a right password, the remembered device the cookie names for this person, unexpired; with none, the second
 *     step is asked (`signin.second_step_asked`) and the caller sets the pending step and sends the code.
 * A password, a hash, the device token and the typed address (for an address that is nobody's) appear in no row.
 */
export async function checkPasswordSignin(rawEmail: unknown, password: unknown, deviceToken: string | null, ip: string | null, now = new Date()): Promise<PasswordCheck> {
  if (typeof rawEmail !== "string" || rawEmail.length > MOST_TYPED_ADDRESS || typeof password !== "string" || password.length > MOST_TYPED_PASSWORD) return REFUSED;
  const byIp: RateLimitTake = await takeIpLimit("password_try_ip", ip, now);
  const email = normalizeEmail(rawEmail);
  const byAddress: RateLimitTake = byIp === "taken" ? await takeRateLimit("password_try_email", hashTriedAddress(email ?? rawEmail.trim().toLowerCase()), now) : "refused";
  const over = byIp !== "taken" ? { take: byIp, limit: "ip" } : byAddress !== "taken" ? { take: byAddress, limit: "email" } : null;
  if (over) {
    if (over.take === "first_refusal") await audit("rate_limited", null, ip, { limit: over.limit });
    return REFUSED;
  }

  const [settings, person] = await Promise.all([getParentSettings(), personWithPassword(email)]);
  const counts = (await enterableGuardianRows(person?.id ?? NOBODY)).length > 0;
  const hash = person?.authUserId && person.hash ? person.hash : null;
  const right = await verifyPassword({ hash: hash ?? await dummyHash(), password }).catch(() => false) && hash !== null;

  const who = person ? { id: person.id, email: person.email } : null;
  const step = secondStepFor({ level: settings.level, hasSecondFactor: false }); // SI-6 (the app) and SI-7 (passkeys) give hasSecondFactor its value
  const reason: PasswordRefusal | null = !email ? "not_an_address"
    : parentDoorClosed(settings) ? "signins_off"
    : !person ? "unknown_email"
    : person.authUserId === null ? "no_sign_in_account"
    : !hash ? "no_password"
    : !right ? "wrong_password"
    : person.blocked ? "blocked"
    : !counts ? "no_enabled_guardian"
    : step.step !== "emailed_code" ? "strict_no_factor"
    : null;
  if (reason || !person || !person.credentialId || !person.updatedAt) {
    await audit(reason ?? "no_password", reason === "not_an_address" || reason === "unknown_email" ? null : who, ip);
    return REFUSED;
  }

  const proof: PasswordProof = { credentialId: person.credentialId, credentialUpdatedAt: person.updatedAt };
  const device = await rememberedDevice(person.id, deviceToken, now);
  if (!device) {
    await writeAudit({ actor: parentActor(person), action: "signin.second_step_asked", targetType: "parent", targetId: person.id,
      after: { step: step.step }, ip });
  }
  return { ok: true, person: { id: person.id, email: person.email }, password: proof, device };
}
