import { describe, it, expect, vi, beforeEach } from "vitest";
import { asParent, asParentChoosing, asParentEnrolling, pageOutcome, redirectOf, renderPage, signedOut } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The breach service is never asked here: every password chosen from a link is one it hasn't seen.
vi.mock("@/lib/parents/breach-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/parents/breach-check")>()), checkBreach: async () => ({ outcome: "not_found" as const }),
}));

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parentAuthSession } from "@/lib/db/schema";
import { resolveParentSession } from "@/lib/auth/resolve";
import { signInFromLink } from "@/lib/auth/parent-link-signin";
import { AccessDenied, enrolmentAction, parentAction, parentLayoutCtx, parentSessionAction, requireEnrolmentPage, requireParentPage } from "@/lib/guards";
import { asAppFamilyId } from "@/lib/families/ids";
import { ENROL_WINDOW_MS } from "@/lib/parents/enrolment-rule";
import { ENROLMENT_COPY } from "@/lib/parents/enrolment-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { confirmMyAuthenticator, remakeMyBackupCodes, startMyAuthenticator, turnOffMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { removeMyPasskey } from "@/lib/parents/passkey-settings";
import { changeMyPassword, forgetMyDevice } from "@/lib/parents/signin-settings";
import { choosePasswordFromLink } from "@/lib/parents/password-set";
import { askAgainPassword } from "@/lib/parents/asking-again";
import OneMoreStep from "@/app/one-more-step/page";
import ChooseFamily from "@/app/choose-family/page";
import { confirmEnrolmentAppAction, startEnrolmentAppAction } from "@/app/one-more-step/actions";
import { chooseFamilyAction } from "@/app/choose-family/actions";
import { changePasswordAction, forgetDeviceAction, newBackupCodesAction, removePasskeyAction, renamePasskeyAction, signOutEverywhereAction,
  startAuthenticatorAction, turnOffAuthenticatorAction } from "@/app/(parent)/family/sign-in/actions";
import { resetDb, seedGuardianInFamily, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, cookieNamed, passwordStep, signInThroughDoor } from "../helpers/parent-door";
import { deviceRows, mintLink, seedDevice, seedPassword } from "../helpers/signin-links";
import { appCode, authenticatorRows, backupCodeRows } from "../helpers/authenticator";
import { addPasskey, passkeyRows, registerOptions, seedPasskey } from "../helpers/passkey";

/**
 * Strict's enrolment (the sign-in release, slice SI-10a; open questions 21, 22, 25 and 34 of the app-owned families
 * spec): under Strict a guardian with neither a passkey nor an authenticator app who proves their password, at the
 * door or from a set-up link, gets an enrolling session that reaches /one-more-step and nothing else, where they add a
 * passkey or set up the app; the factor's own transaction makes the session whole. The gate signs out, under Strict,
 * any other session of a person with no factor. Strict is stored by each test (seedParentSettings({ level: "strict" }))
 * and a reset of the database ends it.
 */
const NEW_PASSWORD = "a long new password for the enrolment";
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
type SessionRow = { id: string; familyId: string | null; strongAt: Date | null; deviceId: string | null; enrolUntil: Date | null };
const sessionsOf = async (authUserId: string): Promise<SessionRow[]> => (await db.select({ id: parentAuthSession.id, familyId: parentAuthSession.familyId,
  strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt), deviceId: parentAuthSession.deviceId,
  enrolUntil: sql<Date | null>`${parentAuthSession.enrolUntil}`.mapWith(parentAuthSession.enrolUntil) })
  .from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId))).map((r) => ({ ...r, familyId: r.familyId === null ? null : String(r.familyId) }));
const sessionRow = async (id: string) => (await db.select({ id: parentAuthSession.id, userId: parentAuthSession.userId, familyId: parentAuthSession.familyId,
  strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt),
  enrolUntil: sql<Date | null>`${parentAuthSession.enrolUntil}`.mapWith(parentAuthSession.enrolUntil) }).from(parentAuthSession).where(eq(parentAuthSession.id, id)))[0] ?? null;
/** What the gate makes of a session now, as a page request would ask it (src/lib/auth/identity.ts calls the same). */
async function stateOf(sessionId: string) {
  const s = await sessionRow(sessionId);
  if (!s) return { status: "gone" as const };
  return resolveParentSession({ id: s.id, userId: s.userId, familyId: s.familyId === null ? null : asAppFamilyId(String(s.familyId)) }, DOOR_IP);
}
const refusedFor = async (parentId: string) => (await audits("signin.refused")).filter((r) => r.targetId === parentId).map((r) => r.after);

/** A guardian with a password and a family of their own, as the door's tests seed one. */
async function seedGuardianWithPassword(name: string, familyQboId: string) {
  const p = await seedParent({ name, email: `${name.toLowerCase()}@example.com` });
  await seedGuardianInFamily({ parentId: p.id, familyQboId });
  await seedPassword(p.authUserId, DOOR_PASSWORD);
  return p;
}
/** A session the door's password made under Strict for `p` (who has no second factor): its cookie and its row's id. */
async function enrolledAtTheDoor(p: { id: string; email: string; authUserId: string }, next?: string) {
  const step = await passwordStep(p.email, next ? { next } : {});
  expect(step.body).toEqual({ ok: true, next: next ? `/one-more-step?next=${encodeURIComponent(next)}` : "/one-more-step" });
  const cookie = cookieNamed(step.res, "session_token");
  expect(cookie).not.toBe("");
  const rows = await sessionsOf(p.authUserId);
  const made = rows.at(-1)!;
  return { cookie, sessionId: made.id, ctx: { parentId: p.id, sessionId: made.id, email: p.email, ip: DOOR_IP }, res: step.res };
}
const inWindow = () => new Date(Date.now() + ENROL_WINDOW_MS);

beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

describe("the gate under Strict", () => {
  it("answers an enrolling session `enrol`, whatever family it holds, with no name and no family", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedParentSettings({ level: "strict" });
    const plain = await seedParentSession(ana.authUserId, { familyQboId: "F1", enrolUntil: inWindow() });
    const choosing = await seedParentSession(ana.authUserId, { enrolUntil: inWindow() });
    for (const s of [plain, choosing]) expect(await stateOf(s.id)).toEqual({ status: "enrol", parentId: ana.id, sessionId: s.id, email: "ana@example.com" });
    expect(await refusedFor(ana.id)).toEqual([]);
  });

  it("signs out, at Strict, a session with no window of a person with no factor, however it was made, and keeps a factor holder's", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    const ben = await seedGuardianWithPassword("Ben", "F2");
    await seedPasskey(ben.id);
    // Sessions from before the switch: an emailed code's (proved, with a device), and one from before the release.
    const device = await seedDevice(ana.id);
    const proved = await seedParentSession(ana.authUserId, { familyQboId: "F1", strongAt: new Date(), deviceId: device.id });
    const old = await seedParentSession(ana.authUserId, { familyQboId: "F1" });
    const bens = await seedParentSession(ben.authUserId, { familyQboId: "F2" });
    expect((await stateOf(proved.id)).status).toBe("ok");
    await seedParentSettings({ level: "strict" });
    for (const s of [proved, old]) {
      expect(await stateOf(s.id)).toEqual({ status: "none" });
      expect(await sessionRow(s.id)).toBeNull();
    }
    expect(await refusedFor(ana.id)).toEqual([{ reason: "strict_no_factor" }, { reason: "strict_no_factor" }]);
    expect((await stateOf(bens.id)).status).toBe("ok");
    expect(await refusedFor(ben.id)).toEqual([]);
    // Back at Standard the gate reads nothing new for a session with no window: Ana's next session is whole.
    await seedParentSettings({ level: "standard" });
    const after = await seedParentSession(ana.authUserId, { familyQboId: "F1" });
    expect((await stateOf(after.id)).status).toBe("ok");
  });

  it("ends an enrolling session whose window passed, or once the club is back at Standard, or once a factor came through another session, and leaves the other alone", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedParentSettings({ level: "strict" });
    // The window: a second before its end it is enrolling; a second past it, ended.
    const passed = await seedParentSession(ana.authUserId, { familyQboId: "F1", enrolUntil: new Date(Date.now() - 1000) });
    const live = await seedParentSession(ana.authUserId, { familyQboId: "F1", enrolUntil: inWindow() });
    expect(await stateOf(passed.id)).toEqual({ status: "none" });
    expect(await sessionRow(passed.id)).toBeNull();
    expect((await stateOf(live.id)).status).toBe("enrol");
    // A factor added through a second enrolling session: that one became whole (its window cleared, proved now), this one ends.
    const second = await seedParentSession(ana.authUserId, { familyQboId: "F1", enrolUntil: inWindow() });
    await seedPasskey(ana.id, { createdAt: new Date(Date.now() - 1000) });
    await db.update(parentAuthSession).set({ enrolUntil: null, strongAt: new Date() }).where(eq(parentAuthSession.id, second.id));
    expect(await stateOf(live.id)).toEqual({ status: "none" });
    expect(await sessionRow(live.id)).toBeNull();
    expect((await stateOf(second.id)).status).toBe("ok");
    // Back at Standard, an enrolling session ends at its next request too; a whole one carries on.
    const third = await seedParentSession(ana.authUserId, { familyQboId: "F1", enrolUntil: inWindow() });
    await seedParentSettings({ level: "standard" });
    expect(await stateOf(third.id)).toEqual({ status: "none" });
    expect((await stateOf(second.id)).status).toBe("ok");
    expect(await refusedFor(ana.id)).toEqual([{ reason: "enrol_ended" }, { reason: "enrol_ended" }, { reason: "enrol_ended" }]);
  });
});

describe("the guards", () => {
  const who = { parentId: "11111111-1111-4111-8111-111111111111", sessionId: "s-enrolling", email: "ana@example.com" };
  const identity = { door: "parent" as const, ...who, guardianId: "22222222-2222-4222-8222-222222222222", familyId: asAppFamilyId("33333333-3333-4333-8333-333333333333"),
    name: "Ana", families: [] };

  it("sends an enrolling session from every parent page and the chooser to /one-more-step, carrying the page asked for", async () => {
    asParentEnrolling(who);
    expect(await redirectOf(requireParentPage("/payments"))).toBe("/one-more-step?next=%2Fpayments");
    expect(await redirectOf(requireParentPage())).toBe("/one-more-step");
    expect(await parentLayoutCtx()).toBeNull();
    expect(await pageOutcome(ChooseFamily, { searchParams: { next: "/season" } })).toEqual({ redirect: "/one-more-step?next=%2Fseason" });
  });

  it("lets only an enrolling session reach /one-more-step: a whole one goes home, none to sign in", async () => {
    asParentEnrolling(who);
    expect(await requireEnrolmentPage()).toMatchObject(who);
    asParent(identity);
    expect(await redirectOf(requireEnrolmentPage())).toBe("/");
    asParentChoosing(identity);
    expect(await redirectOf(requireEnrolmentPage())).toBe("/");
    signedOut();
    expect(await redirectOf(requireEnrolmentPage())).toBe("/sign-in");
    expect(await pageOutcome(OneMoreStep)).toEqual({ redirect: "/sign-in" });
  });

  it("refuses an enrolling session every parent action and the chooser's; enrolmentAction admits it alone", async () => {
    const anyParent = parentAction(async () => "ran");
    const anySession = parentSessionAction(async () => "ran");
    const enrolling = enrolmentAction(async (ctx) => ctx);
    asParentEnrolling(who);
    await expect(anyParent()).rejects.toBeInstanceOf(AccessDenied);
    await expect(anySession()).rejects.toBeInstanceOf(AccessDenied);
    await expect(chooseFamilyAction(identity.guardianId)).rejects.toBeInstanceOf(AccessDenied);
    for (const press of [() => changePasswordAction(NEW_PASSWORD, NEW_PASSWORD), () => signOutEverywhereAction(), () => forgetDeviceAction(identity.guardianId),
      () => startAuthenticatorAction(), () => newBackupCodesAction(), () => turnOffAuthenticatorAction(), () => renamePasskeyAction("abc", "Phone"),
      () => removePasskeyAction("abc")]) {
      await expect(press()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await enrolling()).toMatchObject(who);
    for (const set of [() => asParent(identity), () => asParentChoosing(identity), () => signedOut()]) {
      set();
      await expect(enrolling()).rejects.toBeInstanceOf(AccessDenied);
      await expect(startEnrolmentAppAction()).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("draws /one-more-step for an enrolling session: its words, two boxes and the sign-out press, and nothing of who they are", async () => {
    asParentEnrolling(who);
    const html = await renderPage(OneMoreStep, { searchParams: { next: "/payments" } });
    const text = (s: string) => s.replaceAll("'", "&#x27;");
    for (const words of [ENROLMENT_COPY.title, ENROLMENT_COPY.lede, ENROLMENT_COPY.passkeyTitle, ENROLMENT_COPY.passkeyWhat, ENROLMENT_COPY.appTitle,
      ENROLMENT_COPY.appWhat, ENROLMENT_COPY.appSetUp, ENROLMENT_COPY.foot]) expect(html).toContain(text(words));
    for (const value of [who.email, who.parentId, who.sessionId]) expect(html).not.toContain(value);
  });
});

describe("the door under Strict", () => {
  it("leads the right password of a person with no factor to an enrolling session: no proof, no device, on /one-more-step with the page asked for", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedDevice(ana.id);
    await seedParentSettings({ level: "strict" });
    const before = Date.now();
    const s = await enrolledAtTheDoor(ana, "/payments");
    expect(cookieNamed(s.res, "device")).toBe("");
    const [row] = await sessionsOf(ana.authUserId);
    expect(row).toMatchObject({ strongAt: null, deviceId: null });
    expect(row!.enrolUntil!.getTime()).toBeGreaterThanOrEqual(before + ENROL_WINDOW_MS - 1000);
    expect(row!.enrolUntil!.getTime()).toBeLessThanOrEqual(Date.now() + ENROL_WINDOW_MS + 1000);
    expect((await audits("signin.second_step_asked")).map((r) => r.after)).toEqual([{ step: "enrol" }]);
    expect((await audits("signin")).map((r) => (r.after as { enrolling?: boolean }).enrolling)).toEqual([true]);
    expect(await audits("signin.device_remembered")).toEqual([]);
    expect(await deviceRows(ana.id)).toHaveLength(1);
    expect(outbox).toEqual([]);
    expect(await stateOf(s.sessionId)).toEqual({ status: "enrol", parentId: ana.id, sessionId: s.sessionId, email: "ana@example.com" });
    // Every refusal before it is as it was: a wrong password is the one refusal, and makes no session.
    expect((await passwordStep(ana.email, { password: "not the right password at all" })).body).toEqual({ ok: false, error: "rejected" });
    expect(await sessionsOf(ana.authUserId)).toHaveLength(1);
    // Asking again treats the enrolment as no step: refused.
    expect((await askAgainPassword(s.ctx, DOOR_PASSWORD)).ok).toBe(false);
  });

  it("does none of this at Standard: the emailed code is asked, and its session is whole", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    const done = await signInThroughDoor(outbox, ana.email);
    expect(done.codeAsked).toBe(true);
    expect(done.body).toEqual({ ok: true, next: "/" });
    const [row] = await sessionsOf(ana.authUserId);
    expect(row!.enrolUntil).toBeNull();
    expect(row!.strongAt).not.toBeNull();
    expect((await audits("signin.second_step_asked")).map((r) => r.after)).not.toContainEqual({ step: "enrol" });
  });

  it("leads a set-up link's password at Strict to the same enrolment; a reset link signs nobody in", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1", status: "invited" });
    await seedParentSettings({ level: "strict" });
    const set = await choosePasswordFromLink({ purpose: "setup", token: await mintLink(ana.id, "setup"), password: NEW_PASSWORD, again: NEW_PASSWORD }, { ip: DOOR_IP });
    if (!set.ok || !set.signIn) expect.fail(`the set-up gave no sign-in: ${JSON.stringify(set)}`);
    expect(set.signIn).toMatchObject({ parentId: ana.id, enrol: true });
    expect(await signInFromLink(set.signIn)).toBe("/one-more-step");
    const [row] = await sessionsOf(ana.authUserId);
    expect(row).toMatchObject({ strongAt: null, deviceId: null });
    expect(row!.enrolUntil).not.toBeNull();
    expect((await stateOf(row!.id)).status).toBe("enrol");
    // A reset, at Strict as at Standard, signs nobody in: it ends every session, this one included.
    const reset = await choosePasswordFromLink({ purpose: "reset", token: await mintLink(ana.id, "reset"), password: `${NEW_PASSWORD}, again`, again: `${NEW_PASSWORD}, again` }, { ip: DOOR_IP });
    expect(reset).toMatchObject({ ok: true, signIn: null });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
  });
});

describe("what an enrolling session may press", () => {
  it("adds a passkey through the door's own add, and the add makes the session whole, with ten backup codes and `enrolled: true`", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedParentSettings({ level: "strict" });
    const s = await enrolledAtTheDoor(ana);
    const added = await addPasskey(s.cookie);
    expect(added.body.ok).toBe(true);
    expect(added.body.codes).toHaveLength(10);
    expect(await passkeyRows(ana.id)).toHaveLength(1);
    const row = await sessionRow(s.sessionId);
    expect(row!.enrolUntil).toBeNull();
    expect(row!.strongAt).not.toBeNull();
    expect(row!.strongAt!.getTime()).toBeGreaterThanOrEqual((await passkeyRows(ana.id))[0]!.createdAt.getTime());
    expect((await audits("parent.passkey.add")).map((r) => (r.after as { enrolled?: boolean }).enrolled)).toEqual([true]);
    // Whole now: the gate lets it in to its family.
    expect((await stateOf(s.sessionId)).status).toBe("ok");
  });

  it("sets an authenticator app up through the page's actions, and the confirm makes the session whole, with ten backup codes and `enrolled: true`", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedParentSettings({ level: "strict" });
    const s = await enrolledAtTheDoor(ana);
    asParentEnrolling(s.ctx);
    const started = await startEnrolmentAppAction();
    if (!started.ok) expect.fail(`the set-up should begin: ${started.errors.join(" ")}`);
    const confirmed = await confirmEnrolmentAppAction(appCode(started.key.replace(/ /g, "")), started.stamp);
    if (!confirmed.ok) expect.fail(`the set-up should finish: ${confirmed.errors.join(" ")}`);
    expect(confirmed.codes).toHaveLength(10);
    expect(await backupCodeRows(ana.id)).toHaveLength(10);
    const [app] = await authenticatorRows(ana.id);
    const row = await sessionRow(s.sessionId);
    expect(row!.enrolUntil).toBeNull();
    expect(row!.strongAt!.getTime()).toBe(app!.confirmedAt!.getTime());
    expect((await audits("parent.authenticator.on")).map((r) => r.after)).toEqual([{ codesDeleted: 0, enrolled: true }]);
    expect((await stateOf(s.sessionId)).status).toBe("ok");
  });

  it("is refused every other press: new codes, turning the app off, removing a passkey, the password change, forgetting a device", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    const device = await seedDevice(ana.id);
    await seedParentSettings({ level: "strict" });
    const s = await enrolledAtTheDoor(ana);
    const PROVE_AGAIN = { ok: false, errors: [COPY.proveAgain] };
    expect(await remakeMyBackupCodes(s.ctx)).toEqual(PROVE_AGAIN);
    expect(await turnOffMyAuthenticator(s.ctx)).toEqual(PROVE_AGAIN);
    expect(await removeMyPasskey(s.ctx, "abc")).toEqual(PROVE_AGAIN);
    expect(await changeMyPassword(s.ctx, { password: NEW_PASSWORD, again: NEW_PASSWORD })).toEqual(PROVE_AGAIN);
    expect(await forgetMyDevice(s.ctx, device.id)).toEqual(PROVE_AGAIN);
    expect(await deviceRows(ana.id)).toHaveLength(1);
    expect((await sessionRow(s.sessionId))!.enrolUntil).not.toBeNull();
  });

  it("once the window has passed, answers a press in the enrolment's words, and the gate ends the session", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedParentSettings({ level: "strict" });
    const s = await enrolledAtTheDoor(ana);
    await db.update(parentAuthSession).set({ enrolUntil: new Date(Date.now() - 1000) }).where(eq(parentAuthSession.id, s.sessionId));
    expect(await startMyAuthenticator(s.ctx)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    asParentEnrolling(s.ctx);
    expect(await startEnrolmentAppAction()).toEqual({ ok: false, errors: [ENROLMENT_COPY.windowPassed], signInAgain: true });
    expect(await confirmEnrolmentAppAction("123456", "not a stamp")).toMatchObject({ ok: false });
    expect(await authenticatorRows(ana.id)).toEqual([]);
    // The library's options are refused too, making no challenge: the session may add nothing now.
    expect((await registerOptions({ cookie: s.cookie })).res.status).toBe(404);
    expect(await stateOf(s.sessionId)).toEqual({ status: "none" });
  });

  it("at Strict lets a passkey holder, proved, set up an app on Sign-in settings as at Standard", async () => {
    const ana = await seedGuardianWithPassword("Ana", "F1");
    await seedPasskey(ana.id, { createdAt: new Date(Date.now() - 60_000) });
    const s = await seedParentSession(ana.authUserId, { familyQboId: "F1", strongAt: new Date() });
    await seedParentSettings({ level: "strict" });
    const ctx = { parentId: ana.id, sessionId: s.id, email: ana.email, ip: DOOR_IP };
    const started = await startMyAuthenticator(ctx);
    if (!started.ok) expect.fail(`the set-up should begin: ${started.errors.join(" ")}`);
    const done = await confirmMyAuthenticator(ctx, appCode(started.key.replace(/ /g, "")), started.stamp);
    expect(done.ok).toBe(true);
    // Not an enrolment: the session's proof is left as it was, and the row says nothing of one.
    expect((await audits("parent.authenticator.on")).map((r) => r.after)).toEqual([{ codesDeleted: 0 }]);
    expect(await sessionRow(s.id)).toMatchObject({ enrolUntil: null });
  });
});
