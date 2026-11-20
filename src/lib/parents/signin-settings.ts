// A parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a; section 6 of the app-owned families
// spec, "Signing in", and open questions 26, 28, 34 and 36): what the page shows, changing the password, signing out
// everywhere, and the set-up link offered to a person with no password. Everything is read and changed through the
// session's own person (`ctx.parentId`, `ctx.sessionId`, `ctx.email`), never by an id from the address or a form. The
// device list, forgetting one and renewing a device while its session is in use are SI-5b's. Server only; parent code.
import "server-only";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { parent, parentAuthAccount } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { passwordChangedMessage } from "@/lib/mail/messages";
import { checkBreach } from "./breach-check";
import { markBreachCheck } from "./breach-mark";
import { canChangeMyEmail } from "./email-change";
import { PASSWORD_COPY, askWords } from "./password-copy";
import { checkPasswordRule } from "./password-rule";
import { askForPasswordLink } from "./password-request";
import { MOST_SENT } from "./password-set";
import { takeRateLimit } from "./rate-limit";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endParentSessions, forgetDevices, parentActor } from "./sessions";
import { getParentSettings } from "./settings";
import { getClubSettings } from "@/lib/settings/club";
import { CODE_TTL_MS } from "./signin-codes";
import { currentPassword, sessionProvedRecently, sessionStrongAt } from "./asking-again";
import { provedRecently } from "./reask-rule";
import { portalAddress } from "./link-delivery";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;
export type SettingsResult = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * What the page shows, and nothing else: the address the parent signs in with, whether the change of it is offered
 * (canChangeMyEmail()), whether they have a password, whether this session proved itself within the window
 * (provedRecently(), the page's choice between asking again and the change), and whether the club is at Strict, where
 * nothing can be changed here yet (the door's password step refuses every password without a second factor, so nobody
 * can be asked again until SI-6 and SI-7).
 */
export type MySignin = { email: string; canChangeEmail: boolean; hasPassword: boolean; provedRecently: boolean; strict: boolean };

export async function loadMySignin(ctx: ParentCtx, now = new Date()): Promise<MySignin> {
  const [canChangeEmail, password, strongAt, settings] = await Promise.all([
    canChangeMyEmail(ctx), currentPassword(db, ctx.parentId), sessionStrongAt(db, ctx), getParentSettings(),
  ]);
  return { email: ctx.email, canChangeEmail, hasPassword: password !== null, provedRecently: provedRecently(strongAt, now), strict: settings.level === "strict" };
}

const sent = (v: unknown): v is string => typeof v === "string" && v.length <= MOST_SENT;
const PROVE_AGAIN: SettingsResult = { ok: false, errors: [COPY.proveAgain] };

/** Why a change found under the person's lock can't go on: the window run out, blocked, no password, or another one. */
type NotChanged = "not_proved" | "strict" | "blocked" | "no_password" | "password_changed" | "gone";

/**
 * Changing the password, signed in and proved within the window (open questions 26 and 28). In this order:
 * (a) the arguments: two strings of at most MOST_SENT; anything else is a bad request, refused uncounted;
 * (b) the limit per person (`password_change_parent`): each try past it may ask the breach service and make a hash;
 * (c) the window, read for this session (sessionProvedRecently()); the current password is not asked again;
 * (d) the two passwords match and meet the rule (checkPasswordRule(), PASSWORD_COPY's words);
 * (e) the breach check (checkBreach(), with markBreachCheck()): found is refused in words, not checked is taken, its
 *     code in the audit row;
 * (f) hashPassword(), outside any transaction;
 * (g) one transaction in the order above lockedPerson() (sessions.ts): the person's row FOR UPDATE, then, read under it,
 *     the window again on this session, the club not at Strict (refused in the Strict words), the person not blocked, and their `credential` row still there and not
 *     replaced since this session proved itself (its `updated_at` no later than `strong_at`: every writer of a password
 *     holds the person's row); then, as a reset does (writePassword(), password-set.ts), their unused sign-in codes and
 *     those spent within a code's life, their unspent links (a held one included), the `credential` row replaced, every
 *     device forgotten and every session of theirs ended, this one included (open question 26), with one
 *     `parent.password.changed` row: the counts and the breach outcome, never the password or a hash.
 * Then, after the commit and not awaited, a short notice to the address read under the lock (passwordChangedMessage()).
 * A refusal at (c) or (g) says to reload and show it's them again; one at (d) or (e) says why.
 */
export async function changeMyPassword(ctx: Me, raw: { password: unknown; again: unknown }): Promise<SettingsResult> {
  const { password, again } = raw;
  if (!sent(password) || !sent(again)) return { ok: false, errors: [COPY.failed] };
  if ((await takeRateLimit("password_change_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyChanges] };
  if (!(await sessionProvedRecently(db, ctx))) return PROVE_AGAIN;
  if (password !== again) return { ok: false, errors: [PASSWORD_COPY.mismatch] };
  const rule = checkPasswordRule(password);
  if (!rule.ok) return { ok: false, errors: [rule.problem === "too_long" ? PASSWORD_COPY.tooLong : PASSWORD_COPY.tooShort] };

  const breach = await checkBreach(password);
  await markBreachCheck(breach);
  if (breach.outcome === "found") return { ok: false, errors: [PASSWORD_COPY.breached] };
  const hash = await hashPassword(password);

  let changed: { to: string } | NotChanged;
  try {
    changed = await db.transaction(async (tx) => {
      const [me] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
      if (!me) return "gone" as const;
      const now = new Date(); // read once the person's row is held
      const strongAt = await sessionStrongAt(tx, ctx);
      if (!provedRecently(strongAt, now)) return "not_proved" as const;
      // Under Strict nothing is changed here yet (the page says so): a proof made at Standard before the club moved on
      // is no way past it.
      if ((await getParentSettings(tx)).level === "strict") return "strict" as const;
      if (me.blocked) return "blocked" as const;
      const had = await currentPassword(tx, ctx.parentId);
      if (!had) return "no_password" as const;
      if (had.credentialUpdatedAt.getTime() > strongAt!.getTime()) return "password_changed" as const;

      const codesDeleted = await deleteUnusedSigninCodes(ctx.parentId, tx, { spentSince: new Date(now.getTime() - CODE_TTL_MS) });
      const linksDeleted = await deleteUnusedSigninLinks(ctx.parentId, tx);
      await tx.update(parentAuthAccount).set({ password: hash, updatedAt: now })
        .where(and(eq(parentAuthAccount.id, had.credentialId), eq(parentAuthAccount.providerId, "credential")));
      const devicesForgotten = await forgetDevices(ctx.parentId, tx);
      const sessionsEnded = await endParentSessions(ctx.parentId, tx);
      await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.password.changed", targetType: "parent", targetId: ctx.parentId,
        after: { breachChecked: breach.outcome === "not_found", ...(breach.outcome === "not_checked" ? { breachNotChecked: breach.why } : {}),
          codesDeleted, linksDeleted, devicesForgotten, sessionsEnded }, ip: ctx.ip }, tx);
      return { to: me.email };
    });
  } catch {
    // The hash is a parameter of the write, and a failed query's error carries its parameters: never let it reach a log.
    throw new Error("password_change_failed");
  }
  if (changed === "strict") return { ok: false, errors: [COPY.strict] };
  if (typeof changed === "string") return PROVE_AGAIN;

  const to = changed.to;
  void (async () => {
    const [brand, club] = await Promise.all([currentBrand(), getClubSettings()]);
    const message = passwordChangedMessage(brand, to, { passwordPage: `${portalAddress()}/sign-in/password`, contact: club.treasurerEmail });
    await sendMail(message, { purpose: "password_changed", actor: parentActor({ id: ctx.parentId, email: to }), ip: ctx.ip });
  })().catch(() => undefined); // a send that fails is audited by sendMail() (mail.failed); nothing here may surface
  return { ok: true, message: COPY.changed };
}

/**
 * "Sign out everywhere" (open question 26): every session of the person ended, this one included, and every device the
 * portal remembers for them forgotten, in one transaction in the order above lockedPerson() (the person's row FOR
 * UPDATE, their devices, their sessions), with one `parent.sessions.end_all` row and its counts. Not asked again (the
 * lead's choice 9 of the sign-in release: it leaves nobody signed in, the one who pressed it included), and open to a
 * person with no password too. Limited per person (`signin_settings_parent`).
 */
export async function signOutEverywhere(ctx: Me): Promise<SettingsResult> {
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyPresses] };
  await db.transaction(async (tx) => {
    const [me] = await tx.select({ email: parent.email }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    const devicesForgotten = await forgetDevices(ctx.parentId, tx);
    const sessionsEnded = await endParentSessions(ctx.parentId, tx);
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me?.email ?? ctx.email }), action: "parent.sessions.end_all", targetType: "parent", targetId: ctx.parentId,
      after: { devicesForgotten, sessionsEnded }, ip: ctx.ip }, tx);
  });
  return { ok: true, message: COPY.everywhereDone };
}

/**
 * The set-up link offered to a person with no password (open question 34): "Set up or reset my password"
 * (askForPasswordLink(), password-request.ts) for the session's own address, called as it is, with its own limits
 * (`password_ask_email`, `password_ask_ip`), resend wait, rows and one answer (its mail is not awaited). Nothing in the
 * session alone sets a password: the link does, from the mailbox. At Strict nothing is mailed on request, and the answer
 * says so, as the request page's does (askWords()).
 */
export async function askMySetupLink(ctx: Me): Promise<SettingsResult> {
  const { delivery } = await askForPasswordLink(ctx.email, ctx.ip);
  void delivery;
  const { level } = await getParentSettings();
  return { ok: true, message: askWords(level === "strict").answer ?? PASSWORD_COPY.askAnswer };
}
