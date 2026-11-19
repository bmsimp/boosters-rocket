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
import { RATE_LIMITS, giveBackRateLimit, takeRateLimitPlace, type RateLimitPlace, type RateLimitTake } from "./rate-limit";
import { enterableGuardianRows, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed } from "./settings";
import { takeIpLimit, type PasswordProof } from "./signin-codes";
import { deviceOfAddress, rememberedDevice } from "./devices";
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
 * Better Auth's own sign-in route hashes a password for an unknown address). It is begun when this module loads, so
 * no try waits for the hash to be made: the first refusal after a restart costs one check, as every other does.
 */
const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString("base64url"));
DUMMY_HASH.catch(() => undefined); // never an unhandled rejection at load; a try that awaits it still meets the failure

/**
 * Password checks wait their turn. One check (scrypt as better-auth/crypto runs it: N=16384, r=16, p=1) takes 32 MiB
 * of memory and about a tenth of a second of a core, on Node's thread pool, which has four threads and serves the rest
 * of the app too (files, compression, name lookups). So at most two run at once in this process (64 MiB, and two
 * threads left for everything else), and at most MOST_WAITING_TO_CHECK wait behind them: at two checks a tenth of a
 * second, the last of twenty waits about a second, and about three on a slow host where a check takes three times as
 * long. A try that arrives with the wait full is turned away at once with the over-limit answer, before it is counted
 * or reads anything (checkPasswordSignin()), so a flood of tries for made-up addresses with the visitor's address
 * unknown (the per-IP limit skipped, takeIpLimit()) neither grows a queue without end nor keeps a parent waiting behind
 * it for minutes. A try whose request has been given up (its client gone: the request's signal) leaves the wait and
 * never runs its check. It queues every try alike, a parent's too, and depends on nothing typed, so it tells nothing
 * about an address.
 */
const MOST_CHECKS_AT_ONCE = 2;
export const MOST_WAITING_TO_CHECK = 20;
let checking = 0;
type Waiter = { go: () => void };
const waitingToCheck: Waiter[] = [];
/** How many tries are waiting for a check now. */
export const passwordChecksWaiting = (): number => waitingToCheck.length;
const waitIsFull = () => checking >= MOST_CHECKS_AT_ONCE && waitingToCheck.length >= MOST_WAITING_TO_CHECK;

/** Waits for a turn: true when it is this try's, false when its request was given up first (and it has left the wait). */
function waitForTurn(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const me: Waiter = { go: () => { signal?.removeEventListener("abort", leave); resolve(true); } };
    function leave() {
      const at = waitingToCheck.indexOf(me);
      if (at >= 0) { waitingToCheck.splice(at, 1); resolve(false); }
    }
    waitingToCheck.push(me);
    signal?.addEventListener("abort", leave, { once: true });
  });
}

/** Runs `work` in its turn: its result, or "busy" when the wait is full, or "gone" when the request was given up. */
async function inTurn<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<{ result: T } | "busy" | "gone"> {
  if (signal?.aborted) return "gone";
  if (checking < MOST_CHECKS_AT_ONCE) checking++;
  else if (waitingToCheck.length >= MOST_WAITING_TO_CHECK) return "busy";
  else if (!(await waitForTurn(signal))) return "gone";
  try {
    if (signal?.aborted) return "gone";
    return { result: await work() };
  } finally {
    const nextOne = waitingToCheck.shift();
    if (nextOne) nextOne.go(); else checking--; // the one finishing hands its place over
  }
}

/** When a full wait was last audited: at most once per window of the per-address count, never once per try. */
let busyAuditedAt = Number.NEGATIVE_INFINITY;
async function turnedAwayBusy(ip: string | null, now: Date) {
  if (now.getTime() - busyAuditedAt < RATE_LIMITS.password_try_email.windowMs) return;
  busyAuditedAt = now.getTime();
  await audit("rate_limited", null, ip, { limit: "busy" });
}

/** Why a password signs nobody in, for the audit row only. */
export type PasswordRefusal = "rate_limited" | "not_an_address" | "signins_off" | "unknown_email" | "no_sign_in_account" | "no_password"
  | "wrong_password" | "blocked" | "no_enabled_guardian" | "strict_no_factor";

/**
 * A right password: the person, the address it was proved with (as the portal holds it), the `credential` row it was
 * checked against, the remembered device the request's device cookie names for this person, or null (none, expired,
 * forgotten, another person's), when the second step is to be asked, and when the check finished (`at`: what follows,
 * the pending step and its code, is timed from it, so a wait for a turn never shortens them). Every refusal is
 * `{ ok: false }`, with `limited` when it was over a limit or turned away from a full wait, which the page may say in
 * words of its own: each is decided before the person or their password is read, by what the visitor sent alone (the
 * address typed, and a device cookie only its own device's row answers to), so it is the same for an address on file
 * and one that isn't.
 */
export type PasswordCheck = { ok: true; person: { id: string; email: string }; password: PasswordProof; device: { deviceId: string } | null; at: Date }
  | { ok: false; limited: boolean };
const REFUSED: PasswordCheck = { ok: false, limited: false };
const LIMITED: PasswordCheck = { ok: false, limited: true };

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
 * own device cookie, read by src/lib/auth/parent-signin-step.ts, and the signal, which says the request was given up):
 * (a) the arguments: an address of at most MOST_TYPED_ADDRESS characters and a password of at most MOST_TYPED_PASSWORD;
 *     anything else is the refusal, uncounted and unrecorded; a request already given up is refused the same way;
 * (b) the wait for a check: when it is full (inTurn()), the over-limit answer at once, counting and reading nothing
 *     (audited once per window, `limit: "busy"`, naming nobody);
 * (c) the limit per IP address (`password_try_ip`; skipped when the address is unknown: every visitor would share one count);
 * (d) the address, read with normalizeEmail(), and the try's place, taken before the person or the password is read so
 *     tries sent at once can't slip past: against the remembered device when the request carries a device cookie that
 *     names an unexpired device of the person who holds the address (deviceOfAddress(), read only when a cookie of a
 *     device token's shape is there; `password_try_device`, keyed by the device's row), otherwise against the address
 *     (`password_try_email`, counted under hashTriedAddress(), never the address (what was typed, lower-cased, when it
 *     is no address), whatever it names); not taken while the IP address is over its limit;
 * (e) the reads, the same whoever the address names: the parents' settings (the door and the level), the person by
 *     address with their sign-in account and their `credential` row, and their rows that count (read for a fixed
 *     nobody when the address is nobody's);
 * (f) verifyPassword() in its turn against the row's hash, or, with no person or no password, against a fixed dummy
 *     hash, outside any transaction, so the time doesn't tell; a try turned away there by a full wait, or whose request
 *     was given up while it waited, gives its place back (its password was never checked) and is answered as in (b)
 *     or (a);
 * (g) the verdict, in this order of reasons: over a limit, not an address, sign-ins off, nobody's address, no sign-in
 *     account, no password, a wrong password (`signin.password_wrong`), blocked, no row that counts, and the second step
 *     the club's level asks for (secondStepFor(): under Strict, nothing with no second factor, `strict_no_factor`, on a
 *     remembered device too, which proved only the mailbox). Each is audited once, in its own write
 *     (`signin.password_refused` with its reason, and for over a limit, `limit` (`ip`, `email` or `device`), once per
 *     full window, naming nobody). A refused try keeps its place;
 * (h) for a right password that goes on, its place given back (so only wrong and refused tries are counted, and a
 *     parent's own right password never uses one up), and the remembered device the cookie names for this person,
 *     unexpired; with none, the second step is asked (`signin.second_step_asked`), and the caller sets the pending step
 *     and sends the code, timed from `at`, when the check finished.
 * Over a limit, or turned away by a full wait, the answer is `limited`; every other refusal is the one refusal.
 * A password, a hash, the device token and the typed address (for an address that is nobody's) appear in no row.
 */
export async function checkPasswordSignin(rawEmail: unknown, password: unknown, deviceToken: string | null, ip: string | null, now = new Date(), signal?: AbortSignal): Promise<PasswordCheck> {
  if (typeof rawEmail !== "string" || rawEmail.length > MOST_TYPED_ADDRESS || typeof password !== "string" || password.length > MOST_TYPED_PASSWORD) return REFUSED;
  if (signal?.aborted) return REFUSED;
  if (waitIsFull()) { await turnedAwayBusy(ip, now); return LIMITED; }
  const byIp: RateLimitTake = await takeIpLimit("password_try_ip", ip, now);
  const email = normalizeEmail(rawEmail);
  const ownDevice = byIp === "taken" && email ? await deviceOfAddress(email, deviceToken, now) : null;
  const place: RateLimitPlace = byIp !== "taken" ? { take: "refused", placeId: null }
    : ownDevice ? await takeRateLimitPlace("password_try_device", ownDevice.deviceId, now)
    : await takeRateLimitPlace("password_try_email", hashTriedAddress(email ?? rawEmail.trim().toLowerCase()), now);
  const over = byIp !== "taken" ? { take: byIp, limit: "ip" } : place.take !== "taken" ? { take: place.take, limit: ownDevice ? "device" : "email" } : null;
  if (over) {
    if (over.take === "first_refusal") await audit("rate_limited", null, ip, { limit: over.limit });
    return LIMITED;
  }

  const [settings, person] = await Promise.all([getParentSettings(), personWithPassword(email)]);
  const counts = (await enterableGuardianRows(person?.id ?? NOBODY)).length > 0;
  const hash = person?.authUserId && person.hash ? person.hash : null;
  const against = hash ?? await DUMMY_HASH;
  const checked = await inTurn(() => verifyPassword({ hash: against, password }).catch(() => false), signal);
  const at = new Date(); // after the wait for a turn: whatever follows is timed from here
  if (checked === "busy" || checked === "gone") {
    await giveBackRateLimit(place.placeId);
    if (checked === "gone") return REFUSED;
    await turnedAwayBusy(ip, at);
    return LIMITED;
  }
  const right = checked.result && hash !== null;

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

  // A right password that goes on gives its place back: it is never counted against the parent.
  await giveBackRateLimit(place.placeId);
  const proof: PasswordProof = { credentialId: person.credentialId, credentialUpdatedAt: person.updatedAt };
  const device = await rememberedDevice(person.id, deviceToken, at);
  if (!device) {
    await writeAudit({ actor: parentActor(person), action: "signin.second_step_asked", targetType: "parent", targetId: person.id,
      after: { step: step.step }, ip });
  }
  return { ok: true, person: { id: person.id, email: person.email }, password: proof, device, at };
}
