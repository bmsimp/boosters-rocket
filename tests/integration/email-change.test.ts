import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// Since stage 3's slice 11d a parent's change of sign-in email is the portal's alone: nothing is read from QuickBooks or
// written to it, which the stub proves (it answers what the pages and the staff writes these tests make ask, never Intuit).
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

/**
 * What happens meanwhile, from outside the confirm: `before` runs once, on its own connection, as the confirm's
 * transaction asks for its first address lock (before it holds any lock); `failing` makes the deletion of the person's
 * unused codes, one of the transaction's own steps, fail as Postgres would end it, `times` times.
 */
const meanwhile = vi.hoisted(() => ({ before: null as null | (() => Promise<unknown>), failing: { times: 0, code: "40P01" } }));
vi.mock("@/lib/parents/sessions", async (original) => {
  const real = await original<typeof import("@/lib/parents/sessions")>();
  return {
    ...real,
    lockEmail: async (...args: Parameters<typeof real.lockEmail>) => {
      const run = meanwhile.before;
      if (run) { meanwhile.before = null; await run(); }
      return real.lockEmail(...args);
    },
    deleteUnusedSigninCodes: async (...args: Parameters<typeof real.deleteUnusedSigninCodes>) => {
      if (meanwhile.failing.times > 0) { meanwhile.failing.times--; throw Object.assign(new Error("ended by the database"), { code: meanwhile.failing.code }); }
      return real.deleteUnusedSigninCodes(...args);
    },
  };
});

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, guardian, parent, parentAuthAccount, parentAuthenticator, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange, qboCustomer, rateLimitEvent, signinCode, writeQueue } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { EMAIL_COPY, confirmMyEmailChange, findMyEmailChange } from "@/lib/parents/email-change";
import { addGuardian, removeGuardian } from "@/lib/parents/guardians";
import { blockPerson } from "@/lib/parents/people";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { sendSecondStepCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { factorCounts, setLevel } from "@/lib/parents/switches";
import { askAgainCode, askAgainPassword } from "@/lib/parents/asking-again";
import { confirmMyAuthenticator, startMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { confirmEmailChangeAction, requestEmailChangeAction } from "@/app/(parent)/family/email/actions";
import HomePage from "@/app/(parent)/page";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import FamilyEmailPage from "@/app/(parent)/family/email/page";
import ConfirmEmailPage from "@/app/(parent)/family/email/[token]/page";
import { seedContactFamilies } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { emailChangeToken, seedEmailChange } from "../helpers/email-change";
import { CHENOWETH, RIVERA } from "../helpers/money";
import { PROVEN_PASSWORD, identityNow, proveRecently, seedParentIn } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, seedParentSettings, seedShape, stu } from "../helpers/roster-cache";
import { NO_CHANGES, appRecordsByCustomer, recordOfCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";
import { credentialRows, holdLink, linkRows, mintLink, seedDevice, seedPassword } from "../helpers/signin-links";
import { appCode, seedAuthenticator } from "../helpers/authenticator";
import { ROSTER_LOCK } from "@/lib/roster/shape";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => {
  meanwhile.before = null; meanwhile.failing.times = 0; meanwhile.failing.code = "40P01";
  await resetDb(); stub.reset(); outbox.length = 0; await seedWorkingMail();
});

const [R_FAMILY, R_PARENT] = [RIVERA.family.qboId, RIVERA.parent.qboId];
const [C_FAMILY, C_PARENT] = [CHENOWETH.family.qboId, CHENOWETH.parent.qboId];
const NEW = "rosalind.moved@family-r-new.example";
const IP = "203.0.113.40";
const staffOp = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000003", label: "reg@club.org" }, ip: "203.0.113.41", permission: "Roster.Family.ReadWrite" };
const audits = async () => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).map((a) => ({ action: a.action, targetType: a.targetType, targetId: a.targetId, before: a.before, after: a.after }));
const auditsOf = async (action: string) => (await audits()).filter((a) => a.action === action);
const cachedEmail = async (qboId: string) => (await db.select({ email: qboCustomer.email }).from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0]!.email;
const person = async (id: string) => (await db.select().from(parent).where(eq(parent.id, id)))[0]!;
const accountEmail = async (parentId: string) => (await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.email;
const authUserOf = async (parentId: string) => (await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;
const sessionsOf = async (parentId: string) => db.select({ id: parentAuthSession.id }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId));
const codesOf = async (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
/** An Admin's press on the parents' settings, for the switch to Strict. */
const ADMIN_OP = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9", permission: "Settings.Parents.ReadWrite" };
const requests = () => db.select().from(parentEmailChange).orderBy(asc(parentEmailChange.createdAt));
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: null });
const asking = (email: unknown) => { const f = new FormData(); if (typeof email === "string") f.set("email", email); return requestEmailChangeAction(f); };
/** The token in the link mailed to `to`. */
const linkTo = (to: string) => {
  const mail = outbox.find((m) => m.to === to);
  if (!mail) throw new Error(`nothing was mailed to ${to}`);
  return /\/family\/email\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
};
const aCode = (parentId: string) => db.insert(signinCode).values({ parentId, codeHash: "an-unused-code", expiresAt: new Date(Date.now() + 600_000) });
/**
 * What the confirms queued for the worker to send on (stage 3's slice S11e): each item's target and request, by target.
 * Nothing is ever sent from the confirm itself: no test here runs the worker, so the stub is asked nothing.
 */
const queued = async () => (await db.select().from(writeQueue)).map((i) => ({ state: i.state, sent: i.sent, target: i.targetQboId, familyId: i.familyId, request: i.request }))
  .sort((a, b) => String(a.target).localeCompare(String(b.target)));
const DONE = (email: string) => ({ ok: true, message: EMAIL_COPY.done(email), signedOut: true });
const OFFER = `<a class="btn btn-line" href="/family/email">Change my sign-in email</a>`;

describe("asking for the change", () => {
  it("stores the request, mails a link to the new address and a notice to the old, and changes nothing else", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await asking(`  ${NEW.toUpperCase()} `)).toEqual({ ok: true, message: EMAIL_COPY.sent(NEW) });

    expect(outbox.map((m) => m.to).sort()).toEqual([NEW, RIVERA.parent.email].sort());
    const token = linkTo(NEW);
    expect(outbox.find((m) => m.to === NEW)!.text).toContain(`http://localhost:3000/family/email/${token}`);
    // A parent who opens it signed out is told which address to sign in with: the one they use now.
    expect(outbox.find((m) => m.to === NEW)!.text).toContain("use the address you sign in with now, not this one");
    const notice = outbox.find((m) => m.to === RIVERA.parent.email)!;
    // The old address hears that a change was asked for: no link, and not where to.
    expect(`${notice.text}${notice.html}`).not.toMatch(/https?:\/\/|family\/email/);
    expect(`${notice.text}${notice.html}`).not.toContain(NEW);
    expect(notice.text).toContain("If it wasn't you, please tell the club.");
    // Nothing about any family, this one or another, is in either.
    for (const m of outbox) for (const s of [RIVERA.family.name, RIVERA.parent.name, CHENOWETH.family.name, CHENOWETH.parent.email, R_PARENT, C_PARENT]) expect(`${m.subject}${m.text}${m.html}`).not.toContain(s);

    const [row] = await requests();
    // Asked in the session's own family, the app's record: no QuickBooks id is stored, of the family or of any record
    // (stage 3's slice 11d: the address is the person's, and no QuickBooks record is read to ask).
    expect(row).toMatchObject({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyId: r.identity.familyId, newEmail: NEW, usedAt: null });
    expect(row).not.toHaveProperty("familyQboId");
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(token);
    expect(Math.abs(row!.expiresAt.getTime() - (Date.now() + 24 * 3_600_000))).toBeLessThan(60_000);
    // Asked, and audited against the person, without the token.
    const log = await audits();
    expect(log).toEqual([{ action: "parent.email.request", targetType: "parent", targetId: r.identity.parentId, before: { email: RIVERA.parent.email },
      after: { email: NEW, familyId: String(r.identity.familyId) } }]);
    expect(JSON.stringify(log)).not.toContain(token);
    // Nothing else: QuickBooks isn't asked, the address and the session are as they were.
    expect(stub.apiCalls()).toEqual([]);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
  });

  it("asks again: refused, storing and mailing nothing, unless this session proved itself in the last 10 minutes (open question 28)", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // A session from before the password release (no proof), one that proved itself 11 minutes ago, and one whose proof
    // is stamped ahead of the clock: each refused in words that point to sign-in settings.
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirst] });
    await proveRecently(r.identity, PROVEN_PASSWORD, new Date(Date.now() - 11 * 60_000));
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirst] });
    await proveRecently(r.identity, PROVEN_PASSWORD, new Date(Date.now() + 60_000));
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirst] });
    expect(EMAIL_COPY.proveFirst).toContain("Sign-in settings");
    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual(Array.from({ length: 3 }, () => ["parent.email.request.failed", r.identity.parentId, { code: "not_proved" }]));
    // Proved just now: asked, as before.
    await proveRecently(r.identity);
    expect(await asking(NEW)).toEqual({ ok: true, message: EMAIL_COPY.sent(NEW) });
    expect((await requests()).map((x) => x.newEmail)).toEqual([NEW]);
  });

  it("at Strict asks the change for a session proved under Strict, and asks again of one whose proof predates the switch (slice SI-10b)", async () => {
    // Changed on purpose from SI-5a's Strict refusal ("can't be changed here yet"): the switch to Strict clears every
    // proof made before it (setLevel()), so a proof here is Strict's own.
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await seedAuthenticator(r.identity.parentId);
    await proveRecently(r.identity);
    expect(await setLevel("strict", (await factorCounts()).neither, ADMIN_OP)).toMatchObject({ ok: true });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirstWithApp] });
    expect(await requests()).toEqual([]);
    expect(outbox).toEqual([]);
    expect((await audits()).filter((a) => a.action === "parent.email.request.failed").map((a) => a.after)).toEqual([{ code: "not_proved" }]);
    // The page at Strict: the asking again with the app's code, and no Strict branch in place of the form.
    const asksAgain = await renderPage(FamilyEmailPage);
    expect(asksAgain).toContain("First, show it&#x27;s you: enter your password, then the code from your authenticator app.");
    expect(asksAgain).not.toContain("Send me a link");
    // Proved under Strict: the form, and the change asked, as at Standard.
    await proveRecently(r.identity);
    expect(await renderPage(FamilyEmailPage)).toContain("Send me a link");
    expect(await asking(NEW)).toEqual({ ok: true, message: EMAIL_COPY.sent(NEW) });
    expect((await requests()).map((x) => x.newEmail)).toEqual([NEW]);
    expect(outbox.map((m) => m.to).sort()).toEqual([NEW, RIVERA.parent.email].sort());
  });

  it("tells a guardian with no app to show it's them with the emailed code, and one with an app in force with the app's code (slice SI-6b)", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(EMAIL_COPY.proveFirst).toContain("a code we email you");
    expect(EMAIL_COPY.proveFirstWithApp).toContain("the code from your authenticator app");
    expect(EMAIL_COPY.proveFirstWithApp).not.toMatch(/email you|emailed/);
    expect(EMAIL_COPY.proveFirstWithApp).toContain("Sign-in settings");
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirst] });
    // An unfinished set-up is no app: still the emailed code's words.
    const unfinished = await seedAuthenticator(r.identity.parentId, { confirmed: false });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirst] });
    await db.delete(parentAuthenticator).where(eq(parentAuthenticator.id, unfinished.id));
    await seedAuthenticator(r.identity.parentId);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirstWithApp] });
    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
    expect((await audits()).map((a) => a.after)).toEqual(Array.from({ length: 3 }, () => ({ code: "not_proved" })));
  });

  it("refuses a proof made before the person's app came into force in another session, until they show it's them with the app's code (slice SI-6b's second read)", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // This session proved itself a few seconds ago (as with the emailed code); another of theirs then sets an app up.
    await proveRecently(r.identity, PROVEN_PASSWORD, new Date(Date.now() - 5_000));
    const other = await seedParentSession(await authUserOf(r.identity.parentId), { familyId: r.identity.familyId, strongAt: new Date(Date.now() - 4_000) });
    const elsewhere = { ...ctxOf(r.identity), sessionId: other.id };
    const start = await startMyAuthenticator(elsewhere);
    if (!start.ok) throw new Error(`the set-up should begin: ${start.errors.join(" ")}`);
    const secret = start.key.replace(/ /g, "");
    expect(await confirmMyAuthenticator(elsewhere, appCode(secret), start.stamp)).toMatchObject({ ok: true });
    // Within this session's 10 minutes: refused, nothing stored or mailed.
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.proveFirstWithApp] });
    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
    // Asked again with the app's code: asked, as before.
    const first = await askAgainPassword(ctxOf(r.identity), PROVEN_PASSWORD);
    if (!first.ok || first.step !== "app") throw new Error("the app's step should be asked for");
    expect(await askAgainCode(ctxOf(r.identity), first.stamp, appCode(secret, Date.now(), 1))).toMatchObject({ ok: true });
    expect(await asking(NEW)).toEqual({ ok: true, message: EMAIL_COPY.sent(NEW) });
    expect((await requests()).map((x) => x.newEmail)).toEqual([NEW]);
  });

  it("answers the same whatever the new address is, known to the portal and to QuickBooks or not", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    for (const email of [CHENOWETH.parent.email, "nobody.anywhere@example.org"]) {
      outbox.length = 0;
      expect(await asking(email)).toEqual({ ok: true, message: EMAIL_COPY.sent(email) });
      expect(outbox.map((m) => m.to).sort()).toEqual([email, RIVERA.parent.email].sort());
    }
  });

  it("replaces an earlier request that wasn't used: only the newest link works", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking("first.try@family-r-new.example");
    const first = linkTo("first.try@family-r-new.example");
    await asking(NEW);
    const second = linkTo(NEW);
    expect((await requests()).map((x) => x.newEmail)).toEqual([NEW]);
    expect(await findMyEmailChange(ctxOf(r.identity), first)).toEqual({ state: "gone" });
    expect(await findMyEmailChange(ctxOf(r.identity), second)).toEqual({ state: "ask", newEmail: NEW });
  });

  it("refuses an address that isn't one, and the address they sign in with now, and sends nothing", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    for (const bad of ["not an address", "", "a@", `${"x".repeat(320)}@example.com`]) expect(await asking(bad), bad).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    await db.delete(rateLimitEvent); // each ask is counted, a refused one too: these are more than an hour allows
    expect(await asking(undefined)).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    expect(await requestEmailChangeAction({ email: NEW } as unknown as FormData)).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    expect(await asking(` ${RIVERA.parent.email.toUpperCase()}`)).toEqual({ ok: false, errors: [EMAIL_COPY.same] });
    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it("stores the request for a person with no QuickBooks record, one whose record no longer holds their address, and one in two families", async () => {
    const { r } = await seedContactFamilies(stub);
    // A sign-in made by hand: no record of their own in QuickBooks.
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    await proveRecently(hand.identity);
    expect(await asking("hand.moved@family-r-new.example")).toEqual({ ok: true, message: EMAIL_COPY.sent("hand.moved@family-r-new.example") });
    // Rivera's parent, whose record the club re-addressed, and who is a parent of the Chenoweth family too.
    await db.update(qboCustomer).set({ email: "someone.else@family-r.example" }).where(eq(qboCustomer.qboId, R_PARENT));
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    await syncAppRecords();
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await asking(NEW)).toEqual({ ok: true, message: EMAIL_COPY.sent(NEW) });
    expect((await requests()).map((q) => [q.parentId, q.newEmail]).sort()).toEqual([
      [hand.identity.parentId, "hand.moved@family-r-new.example"], [r.identity.parentId, NEW]].sort());
    expect(stub.apiCalls()).toEqual([]);
  });

  it("tells anyone to ask the club while sign-ins are off, and from a closed row, and stores nothing", async () => {
    const { r, c } = await seedContactFamilies(stub);
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, c.identity.guardianId));
    asParent(c.identity);
    await proveRecently(c.identity);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    await seedParentSettings({ signin: false });
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });

    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual([
      ["parent.email.request.failed", c.identity.parentId, { code: "not_offered" }], ["parent.email.request.failed", r.identity.parentId, { code: "not_offered" }]]);
  });

  it("the confirm is rate-limited per person too, and audits its first refusal only", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    for (let i = 0; i < 10; i++) expect(await confirmEmailChangeAction(emailChangeToken())).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    expect(await confirmEmailChangeAction(emailChangeToken())).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyTries] });
    expect(await confirmEmailChangeAction(emailChangeToken())).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyTries] });
    expect((await auditsOf("parent.email.save.failed")).filter((a) => (a.after as { code: string }).code === "rate_limited")).toHaveLength(1);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
  });

  it("is rate-limited per person, and audits the first refusal only", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    for (let i = 0; i < 5; i++) expect(await asking(`try.${i}@family-r-new.example`)).toMatchObject({ ok: true });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyAsks] });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyAsks] });
    expect(await auditsOf("parent.email.request.failed")).toEqual([
      { action: "parent.email.request.failed", targetType: "parent", targetId: r.identity.parentId, before: null, after: { code: "rate_limited" } }]);
  });
});

describe("the link's page, and who is offered the change", () => {
  it("asks, and opening it changes nothing", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    const page = await renderPage(ConfirmEmailPage, { params: { token } });
    expect(page).toContain(`Use ${NEW} to sign in from now on?`);
    expect(page).toContain("Yes, use this address");
    expect(stub.apiCalls()).toEqual([]);
    expect((await requests())[0]!.usedAt).toBeNull();
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
  });

  it("shows the words of an expired link for any other token, and nothing of it", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const theirs = await seedEmailChange({ parentId: c.identity.parentId, guardianId: c.identity.guardianId, familyQboId: C_FAMILY, newEmail: "cordelia.moved@family-c-new.example" });
    asParent(r.identity);
    for (const token of [theirs.token, emailChangeToken(), "not-a-token", "../../etc"]) {
      const page = await renderPage(ConfirmEmailPage, { params: { token } });
      expect(page, token).toContain("This link has expired or has already been used.");
      expect(page, token).not.toContain("cordelia");
      expect(page, token).not.toContain("Yes, use this address");
    }
  });

  it("Home, Family and the details page offer it to a parent with no QuickBooks record, one whose record lost their address, and one in two families", async () => {
    const { r } = await seedContactFamilies(stub);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    await db.update(qboCustomer).set({ email: "someone.else@family-r.example" }).where(eq(qboCustomer.qboId, R_PARENT));
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    await syncAppRecords();
    for (const who of [hand.identity, r.identity]) {
      asParent(who);
      await proveRecently(who);
      expect(await renderPage(FamilyPage), who.name).toContain(OFFER);
      expect(await renderPage(FamilyDetailsPage), who.name).toContain(OFFER);
      expect(await renderPage(HomePage), who.name).toContain("mailing address and sign-in email on your Family page");
      expect(await renderPage(FamilyEmailPage), who.name).toContain("Send me a link");
    }
  });

  it("the email page offers a link to choose a password first, then asks again, then the new address (slice SI-5a)", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await renderPage(FamilyEmailPage)).toContain("Email me a link to choose a password");
    await proveRecently(r.identity, PROVEN_PASSWORD, new Date(Date.now() - 11 * 60_000));
    const asksAgain = await renderPage(FamilyEmailPage);
    expect(asksAgain).toContain("First, show it&#x27;s you");
    expect(asksAgain).not.toContain("Send me a link");
    await proveRecently(r.identity);
    expect(await renderPage(FamilyEmailPage)).toContain("Send me a link");
  });

  it("offers it in books with no parent type", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([{ qboId: "7310", displayName: "Noparent Family", typeQboId: "F", email: "home@noparent.example; work@noparent.example" }, stu("7311", "Nico Noparent", "7310")]);
    const home = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "7310" });
    asParent(home.identity);
    expect(await renderPage(FamilyPage)).toContain(OFFER);
    expect(await renderPage(FamilyDetailsPage)).toContain(OFFER);
    expect(await renderPage(HomePage)).toContain("and your sign-in email on your Family page");
  });

  it("offers it to nobody while sign-ins are off, or from a closed row, and the email page tells them to ask the club", async () => {
    const { r, c } = await seedContactFamilies(stub);
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, c.identity.guardianId));
    asParent(c.identity);
    await proveRecently(c.identity);
    for (const page of [FamilyPage, FamilyDetailsPage]) expect(await renderPage(page)).not.toContain("Change my sign-in email");
    const told = await renderPage(FamilyEmailPage);
    expect(told).toContain("Your sign-in email can&#x27;t be changed here. Please ask the club and they&#x27;ll change it for you.");
    expect(told).not.toContain("Send me a link");
    await seedParentSettings({ signin: false });
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await renderPage(FamilyPage)).not.toContain("Change my sign-in email");
    expect(await renderPage(FamilyEmailPage)).not.toContain("Send me a link");
  });

  it("a link of one who may no longer change it here asks them to ask the club", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    await seedParentSettings({ signin: false });
    expect(await findMyEmailChange(ctxOf(r.identity), token)).toEqual({ state: "ask_club" });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect((await requests())[0]!.usedAt).toBeNull();
  });
});

describe("confirming: the portal alone", () => {
  it("the person's own address changes, what the old address held ends, and QuickBooks is asked nothing", async () => {
    const { r, c } = await seedContactFamilies(stub);
    await aCode(r.identity.parentId);
    // A set-up and a reset link mailed to the old address, a second set-up link held while its mail is on its way
    // there (the request page), a device remembered for it, and a password.
    await mintLink(r.identity.parentId, "setup");
    await mintLink(r.identity.parentId, "reset");
    await holdLink(r.identity.parentId, "setup");
    await seedDevice(r.identity.parentId);
    await seedPassword(await authUserOf(r.identity.parentId), "a long and lovely password");
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    expect(await renderPage(ConfirmEmailPage, { params: { token } })).toContain("Yes, use this address");
    const customers = structuredClone(stub.customers);

    expect(await confirmEmailChangeAction(token)).toEqual(DONE(NEW));
    // Nothing of QuickBooks: no read, no write, and the roster cache holds the record's field as it was.
    expect(stub.apiCalls()).toEqual([]);
    expect(stub.customers).toEqual(customers);
    expect(await cachedEmail(R_PARENT)).toBe(RIVERA.parent.email);

    expect(await person(r.identity.parentId)).toMatchObject({ email: NEW, name: RIVERA.parent.name });
    expect(await accountEmail(r.identity.parentId)).toBe(NEW);
    // Her row as it was: open, and still linked to her own record in the books.
    expect(await db.select({ status: guardian.status, customer: accountingLink.customerId }).from(guardian).leftJoin(accountingLink, eq(accountingLink.guardianId, guardian.id))
      .where(eq(guardian.parentId, r.identity.parentId))).toEqual([{ status: "active", customer: R_PARENT }]);
    // The old address signs in nowhere: no session, no code, no set-up or reset link, and no device remembered for it.
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect(await codesOf(r.identity.parentId)).toEqual([]);
    expect(await linkRows(r.identity.parentId)).toEqual([]);
    expect(await db.select().from(parentDevice).where(eq(parentDevice.parentId, r.identity.parentId))).toEqual([]);
    // The password stays.
    expect(await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).where(eq(parentAuthAccount.userId, await authUserOf(r.identity.parentId)))).toHaveLength(1);
    // The other family is untouched.
    expect(await sessionsOf(c.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    // Spent: the link works once.
    expect((await requests())[0]!.usedAt).not.toBeNull();
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });

    // One row, against the person, in the transaction that made the change.
    // Stage 3's slice S11e: the new address is queued, in that transaction, for her own Parent customer, and the row names it.
    const items = await queued();
    expect(items).toEqual([{ state: "waiting", sent: false, target: R_PARENT, familyId: r.identity.familyId,
      request: { op: "email", role: "parent", qboId: R_PARENT, syncToken: expect.any(String), from: RIVERA.parent.email, to: NEW, guardianId: r.identity.guardianId } }]);
    const [itemId] = (await db.select({ id: writeQueue.id }).from(writeQueue)).map((i) => i.id);
    expect(await auditsOf("parent.email.save")).toEqual([{ action: "parent.email.save", targetType: "parent", targetId: r.identity.parentId, before: { email: RIVERA.parent.email },
      after: { email: NEW, familyId: String(r.identity.familyId), sessionsEnded: 1, linksDeleted: 3, devicesForgotten: 1, queueIds: [itemId] } }]);
    // Nothing decided access: no sign-in was opened, moved or closed.
    for (const action of ["parent.email.changed", "parent.access.granted", "parent.access.moved", "parent.access.ended", "parent.hold.opened"]) {
      expect((await audits()).map((a) => a.action)).not.toContain(action);
    }
    // The confirm changes none of the app's own records.
    const records = await appRecordsByCustomer();
    expect(records.memberships).toContainEqual({ guardianId: r.identity.guardianId, family: R_FAMILY });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("the person signs in again with the new address at once, and never with the old", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    expect(await confirmEmailChangeAction(linkTo(NEW))).toEqual(DONE(NEW));
    outbox.length = 0;
    // The second step's code (since the sign-in release's slice SI-3b, sent for a right password to the person a
    // pending step names): her password, which the change kept, with each address.
    const [cred] = await credentialRows(await authUserOf(r.identity.parentId));
    const step = (email: string) => ({ parentId: r.identity.parentId, email, password: { credentialId: cred!.id, credentialUpdatedAt: cred!.updatedAt } });
    await (await sendSecondStepCode(step(RIVERA.parent.email), IP)).delivery;
    expect(outbox).toEqual([]);
    await (await sendSecondStepCode(step(NEW), IP)).delivery;
    expect(outbox.map((m) => m.to)).toEqual([NEW]);
    const code = /sign-in code: (\d{6})/.exec(outbox[0]!.subject)![1]!;
    expect(await verifySigninCode(step(RIVERA.parent.email), code, IP)).toMatchObject({ ok: false });
    expect(await verifySigninCode(step(NEW), code, IP)).toEqual({ ok: true, codeId: expect.any(String) });
  });

  it("a person with no QuickBooks record, one whose record lost their address, and one in two families each change it", async () => {
    const { r } = await seedContactFamilies(stub);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    await proveRecently(hand.identity);
    await asking("hand.moved@family-r-new.example");
    expect(await confirmEmailChangeAction(linkTo("hand.moved@family-r-new.example"))).toEqual(DONE("hand.moved@family-r-new.example"));
    expect((await person(hand.identity.parentId)).email).toBe("hand.moved@family-r-new.example");

    await db.update(qboCustomer).set({ email: "someone.else@family-r.example" }).where(eq(qboCustomer.qboId, R_PARENT));
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    await syncAppRecords();
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    expect(await confirmEmailChangeAction(linkTo(NEW))).toEqual(DONE(NEW));
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    // Both families keep the person: their rows are as they were, and each still lets them in.
    expect((await enterableGuardianRows(r.identity.parentId)).map((g) => String(g.familyId)).sort())
      .toEqual([String(await recordOfCustomer(C_FAMILY, "family")), String(await recordOfCustomer(R_FAMILY, "family"))].sort());
    expect(await cachedEmail(R_PARENT)).toBe("someone.else@family-r.example");
    expect(await cachedEmail(C_PARENT)).toBe(CHENOWETH.parent.email);
    expect(stub.apiCalls()).toEqual([]);
    // Queued (stage 3's slice S11e): one for Rosalind's own Parent customer, whatever its field holds now (the worker
    // settles that); none for the Chenoweth parent record she shares with Cordelia's open row, which is nobody's own;
    // none for the person with no record of their own.
    expect((await queued()).map((i) => [i.target, i.request.op === "email" ? i.request.to : null])).toEqual([[R_PARENT, NEW]]);
  });

  it("books with no parent type: the family's field is left as it was, and only this parent's address changes", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([{ qboId: "7310", displayName: "Noparent Family", typeQboId: "F", email: "home@noparent.example; work@noparent.example" }, stu("7311", "Nico Noparent", "7310")]);
    const home = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "7310" });
    const work = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "work@noparent.example", sourceQboId: "7310" });
    asParent(home.identity);
    await proveRecently(home.identity);
    await asking("home.new@noparent.example");
    expect(await confirmEmailChangeAction(linkTo("home.new@noparent.example"))).toEqual(DONE("home.new@noparent.example"));
    expect(await cachedEmail("7310")).toBe("home@noparent.example; work@noparent.example");
    expect((await person(home.identity.parentId)).email).toBe("home.new@noparent.example");
    // Queued for the family's own customer, as this membership's (stage 3's slice S11e): only her address is to change there.
    expect(await queued()).toEqual([{ state: "waiting", sent: false, target: "7310", familyId: home.identity.familyId,
      request: { op: "email", role: "family", qboId: "7310", syncToken: expect.any(String), from: "home@noparent.example", to: "home.new@noparent.example", guardianId: home.identity.guardianId } }]);
    expect(await sessionsOf(home.identity.parentId)).toEqual([]);
    // The other parent signs in as before.
    expect((await person(work.identity.parentId)).email).toBe("work@noparent.example");
    expect(await sessionsOf(work.identity.parentId)).toHaveLength(1);
  });

  it("flat books: the member changes their own address, and the member's field is left as it was", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "7410", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example" }]);
    const m = await seedParentIn({ familyQboId: "7410", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "7410" });
    asParent(m.identity);
    await proveRecently(m.identity);
    expect(await renderPage(FamilyPage)).toContain(OFFER);
    await asking("marisol.new@flat.example");
    expect(await confirmEmailChangeAction(linkTo("marisol.new@flat.example"))).toEqual(DONE("marisol.new@flat.example"));
    expect((await person(m.identity.parentId)).email).toBe("marisol.new@flat.example");
    expect(await cachedEmail("7410")).toBe("marisol@flat.example");
    expect(stub.apiCalls()).toEqual([]);
    // Queued for the member's own customer (stage 3's slice S11e).
    expect((await queued()).map((i) => [i.target, i.request.op === "email" ? i.request.role : null])).toEqual([["7410", "member"]]);
  });

  it("takes no roster lock: a confirm made while a roster read holds it finishes", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    let held!: () => void, release!: () => void;
    const isHeld = new Promise<void>((y) => { held = y; });
    const holding = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      held();
      await new Promise<void>((y) => { release = y; });
    });
    await isHeld;
    try {
      expect(await confirmEmailChangeAction(token)).toEqual(DONE(NEW));
    } finally {
      release();
      await holding;
    }
    expect((await person(r.identity.parentId)).email).toBe(NEW);
  });

  it("two presses of the button at once make one change, audited once", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    const results = await Promise.all([confirmEmailChangeAction(token), confirmEmailChangeAction(token)]);
    // One of them makes it; the other meets the request spent, after the change or before it.
    expect(results).toContainEqual(DONE(NEW));
    for (const answer of results) expect([DONE(NEW), { ok: false, errors: [EMAIL_COPY.linkNoGood] }]).toContainEqual(answer);
    expect(await auditsOf("parent.email.save")).toHaveLength(1);
    expect((await person(r.identity.parentId)).email).toBe(NEW);
  });

  it("where the gate won't let the new address into the family yet, they're told it works once the club lets them sign in", async () => {
    const { r } = await seedContactFamilies(stub);
    await seedParentSettings({ requireActiveStudents: true });
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    // The family has no active student any more: the gate would refuse the new address there.
    await db.execute(sql`update student set active = false`);
    expect(await enterableGuardianRows(r.identity.parentId)).toEqual([]);
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: true, message: EMAIL_COPY.finishing, signedOut: true });
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    expect(EMAIL_COPY.finishing).not.toMatch(/QuickBooks|books/);
  });
});

describe("confirming: one address is one person", () => {
  it.each([
    ["a guardian of another family", "other family"],
    ["a person in the portal with no family", "no family"],
  ] as const)("an address %s signs in with is refused before anything changes", async (_, who) => {
    const { r, c } = await seedContactFamilies(stub);
    const taken = who === "other family" ? CHENOWETH.parent.email : NEW;
    if (who === "no family") await seedParent({ name: "Somebody Else", email: NEW });
    await aCode(r.identity.parentId);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(taken);
    const token = linkTo(taken);
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.cantHere] });
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    expect(await sessionsOf(c.identity.parentId)).toHaveLength(1);
    // The link can never work: it is spent, and the refusal is recorded with its code, for staff.
    expect((await requests()).find((q) => q.newEmail === taken)!.usedAt).not.toBeNull();
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetType: "parent", targetId: r.identity.parentId, after: { code: "address_taken" } })]);
    expect(await auditsOf("parent.email.save")).toEqual([]);
    // The words say nothing of another person, a family or why.
    expect(EMAIL_COPY.cantHere).not.toMatch(/family|another|already|taken|someone/i);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("an address staff give another person between the ask and the confirm is refused, and nothing changes", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    expect(await addGuardian(await recordOfCustomer(C_FAMILY, "family"), { name: "Somebody Else", email: NEW }, staffOp)).toMatchObject({ ok: true });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.cantHere] });
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await auditsOf("parent.email.save")).toEqual([]);
  });

  it("an address another person comes to hold just before the change is not promised, nobody is signed out, and the link is spent", async () => {
    const { r } = await seedContactFamilies(stub);
    await aCode(r.identity.parentId);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    let other: string | null = null;
    meanwhile.before = async () => { other = (await seedParent({ name: "Somebody Else", email: NEW })).id; };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    expect(other).not.toBeNull();
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await person(other!)).email).toBe(NEW);
    expect(await auditsOf("parent.email.save")).toEqual([]);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: "address_taken" } })]);
    expect((await requests()).find((q) => q.newEmail === NEW)!.usedAt).not.toBeNull();
    // A second press finds the link spent, and changes nothing.
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
  });

  it("two people's links to one address confirmed at once: one has it, the other keeps theirs", async () => {
    const { r, c } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const rToken = linkTo(NEW);
    outbox.length = 0;
    asParent(c.identity);
    await proveRecently(c.identity);
    await asking(NEW);
    const cToken = linkTo(NEW);
    const results = await Promise.all([confirmMyEmailChange(ctxOf(r.identity), rToken), confirmMyEmailChange(ctxOf(c.identity), cToken)]);
    expect(results.filter((x) => x.ok)).toEqual([DONE(NEW)]);
    // The other is refused: before its transaction, or under its address locks.
    for (const x of results.filter((y) => !y.ok)) expect([{ ok: false, errors: [EMAIL_COPY.cantHere] }, { ok: false, errors: [EMAIL_COPY.askTheClub] }]).toContainEqual(x);
    const emails = [(await person(r.identity.parentId)).email, (await person(c.identity.parentId)).email];
    expect(emails.filter((e) => e === NEW)).toHaveLength(1);
    expect(emails).toContainEqual(results[0]!.ok ? CHENOWETH.parent.email : RIVERA.parent.email);
    expect(await auditsOf("parent.email.save")).toHaveLength(1);
  });
});

describe("confirming: stopped meanwhile, nothing changes", () => {
  const asked = async () => {
    const seeded = await seedContactFamilies(stub);
    await aCode(seeded.r.identity.parentId);
    asParent(seeded.r.identity);
    await proveRecently(seeded.r.identity);
    await asking(NEW);
    return { ...seeded, token: linkTo(NEW) };
  };
  const unchanged = async (r: { identity: ParentIdentity }) => {
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await accountEmail(r.identity.parentId)).toBe(RIVERA.parent.email);
    expect(await auditsOf("parent.email.save")).toEqual([]);
  };

  it.each([
    ["the session that confirms is ended meanwhile", "session_ended"],
    ["the person is blocked meanwhile", "blocked"],
  ] as const)("%s: the change isn't made, the request isn't spent, and they're told so", async (_, why) => {
    const { r, token } = await asked();
    meanwhile.before = async () => {
      if (why === "session_ended") await db.delete(parentAuthSession).where(eq(parentAuthSession.id, r.identity.sessionId));
      else await db.update(parent).set({ blocked: true }).where(eq(parent.id, r.identity.parentId));
    };
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual({ ok: false, errors: [EMAIL_COPY.notMade] });
    expect(EMAIL_COPY.notMade).toBe("Your sign-in email wasn't changed, because you were signed out while it was being made. If you still want to change it, please sign in again and ask once more.");
    await unchanged(r);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await requests()).map((q) => q.usedAt)).toEqual([null]);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: why } })]);
  });

  // A block and a removal delete the request, so the confirm tells the deleted request from one another press spent
  // and says what became of the press, with its own audit row.
  it("a block staff make beside the confirm: the change isn't made, and they're told they were signed out", async () => {
    const { r, token } = await asked();
    meanwhile.before = () => blockPerson(r.identity.parentId, "Custody order on file.", staffOp);
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual({ ok: false, errors: [EMAIL_COPY.notMade] });
    await unchanged(r);
    expect((await person(r.identity.parentId)).blocked).toBe(true);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: "blocked" } })]);
  });

  it("the person's last open row removed beside the confirm: the change isn't made, and they're told they were signed out", async () => {
    const { r, token } = await asked();
    meanwhile.before = () => removeGuardian(r.identity.guardianId, "Moved away.", staffOp);
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual({ ok: false, errors: [EMAIL_COPY.notMade] });
    await unchanged(r);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: "session_ended" } })]);
  });

  it("a new ask from another tab beside the confirm: the first link no longer works, and the refusal is recorded", async () => {
    const { r, token } = await asked();
    meanwhile.before = async () => expect(await asking("rosalind.other@family-r.example")).toMatchObject({ ok: true });
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    await unchanged(r);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: "bad_link" } })]);
    // The new ask's request is the one left, unspent.
    expect((await requests()).map((q) => [q.newEmail, q.usedAt])).toEqual([["rosalind.other@family-r.example", null]]);
  });

  it("a deadlock is tried once more, and the change is made and audited once", async () => {
    const { r, token } = await asked();
    meanwhile.failing.times = 1;
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual(DONE(NEW));
    expect(meanwhile.failing.times).toBe(0);
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    expect(await auditsOf("parent.email.save")).toHaveLength(1);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
  });

  it.each([
    ["fails twice for a deadlock", 2, "40P01", "failed_40P01"],
    ["fails for anything else", 1, "57014", "failed_57014"],
  ] as const)("the transaction %s: nothing changes, the link works again, and the parent is told to try later", async (_, times, code, recorded) => {
    const { r, token } = await asked();
    meanwhile.failing.times = times;
    meanwhile.failing.code = code;
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual({ ok: false, errors: [EMAIL_COPY.tryLater] });
    expect(EMAIL_COPY.tryLater).not.toMatch(/QuickBooks|books/);
    await unchanged(r);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await requests()).map((q) => q.usedAt)).toEqual([null]);
    expect(await auditsOf("parent.email.save.failed")).toEqual([expect.objectContaining({ targetId: r.identity.parentId, after: { code: recorded } })]);
    // The link works again.
    expect(await findMyEmailChange(ctxOf(r.identity), token)).toEqual({ state: "ask", newEmail: NEW });
    expect(await confirmMyEmailChange(ctxOf(r.identity), token)).toEqual(DONE(NEW));
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("confirming with a token that isn't the session's own: one refusal, nothing changed", () => {
  it("family B's token, a token of family A's other parent, and junk", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const other = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    const tokens = {
      familyB: (await seedEmailChange({ parentId: c.identity.parentId, guardianId: c.identity.guardianId, familyQboId: C_FAMILY, newEmail: "cordelia.moved@family-c-new.example" })).token,
      otherPerson: (await seedEmailChange({ parentId: other.identity.parentId, guardianId: other.identity.guardianId, familyQboId: R_FAMILY, newEmail: "hand.moved@family-r-new.example" })).token,
      junk: "x".repeat(43), short: "abc", missing: emailChangeToken(),
    };
    const rows = await requests();
    asParent(r.identity);
    for (const [name, token] of Object.entries(tokens)) {
      expect(await confirmEmailChangeAction(token), name).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
      expect(await findMyEmailChange(ctxOf(r.identity), token), name).toEqual({ state: "gone" });
      expect(await renderPage(ConfirmEmailPage, { params: { token } }), name).not.toMatch(/cordelia|hand\.moved|Yes, use this address/);
    }
    // An argument that isn't a string at all.
    expect(await confirmEmailChangeAction({ token: tokens.familyB } as unknown as string)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });

    expect(stub.apiCalls()).toEqual([]);
    // Nothing of anyone else's request changed: B's and the other parent's are as they were, and unused.
    expect(await requests()).toEqual(rows);
    for (const p of [r, c, other]) expect(await sessionsOf(p.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    expect((await person(other.identity.parentId)).email).toBe("hand.made@family-r.example");
    // The refusals are audited against the session's own person alone.
    expect((await auditsOf("parent.email.save.failed")).map((x) => [x.targetId, x.after]))
      .toEqual(Array.from({ length: 6 }, () => [r.identity.parentId, { code: "bad_link" }]));
  });

  it("the session's own person, with a request that is expired, used, made under another family or link, or from before the link was kept", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const own = { parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyQboId: R_FAMILY, newEmail: NEW };
    const variants: Record<string, Partial<Parameters<typeof seedEmailChange>[0]>> = {
      expired: { expiresAt: new Date(Date.now() - 1000) },
      used: { usedAt: new Date(Date.now() - 1000) },
      underAnotherFamily: { guardianId: c.identity.guardianId, familyQboId: C_FAMILY },
      // The session's own link, but asked in another family (the app's record of Chenoweth's family).
      inAnotherFamily: { familyQboId: C_FAMILY },
      inNoFamily: { familyQboId: null },
      underAnotherLink: { guardianId: c.identity.guardianId },
      fromBefore: { guardianId: null, familyQboId: null },
    };
    asParent(r.identity);
    for (const [name, variant] of Object.entries(variants)) {
      await db.delete(parentEmailChange);
      const { token } = await seedEmailChange({ ...own, ...variant });
      expect(await confirmEmailChangeAction(token), name).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
      expect(await findMyEmailChange(ctxOf(r.identity), token), name).toEqual({ state: "gone" });
    }
    expect(stub.apiCalls()).toEqual([]);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
  });

  it("a change asked in family A can't be confirmed from the same person's session in family B: refused as any other link, nothing changed", async () => {
    const { r } = await seedContactFamilies(stub);
    // Rivera's parent asks in the Rivera family, then is made a parent of the Chenoweth family too and signs in to it.
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await asking(NEW)).toMatchObject({ ok: true });
    const token = linkTo(NEW);
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    await syncAppRecords();
    const inB = await identityNow((await seedParentSession(await authUserOf(r.identity.parentId), { familyQboId: C_FAMILY })).id);
    expect(inB.familyId).not.toBe(r.identity.familyId);
    const rows = await requests();
    asParent(inB);
    expect(await findMyEmailChange(ctxOf(inB), token)).toEqual({ state: "gone" });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    // The request is as it was, unused and in family A; the person's address and sessions are as they were.
    expect(await requests()).toEqual(rows);
    expect(rows).toEqual([expect.objectContaining({ familyId: r.identity.familyId, usedAt: null })]);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(2);
    expect((await auditsOf("parent.email.save.failed")).map((x) => x.after)).toEqual([{ code: "bad_link" }]);
  });
});
