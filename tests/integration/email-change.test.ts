import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// A parent's record is read from QuickBooks and written to it: here that is the stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, guardian, parent, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange, qboConnection, qboCustomer, rateLimitEvent, signinCode } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { EMAIL_COPY, confirmMyEmailChange, findMyEmailChange } from "@/lib/parents/email-change";
import { rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { SOURCE_KEY } from "@/lib/roster/source";
import { confirmEmailChangeAction, requestEmailChangeAction } from "@/app/(parent)/family/email/actions";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import FamilyEmailPage from "@/app/(parent)/family/email/page";
import ConfirmEmailPage from "@/app/(parent)/family/email/[token]/page";
import { inQuickBooks, ofType, qbCustomer, seedContactFamilies, under } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail, untilALockIsAwaited } from "../helpers/db";
import { emailChangeToken, seedEmailChange } from "../helpers/email-change";
import { CHENOWETH, RIVERA, connectCompany } from "../helpers/money";
import { PROVEN_PASSWORD, identityNow, proveRecently, seedParentIn } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { holdTheRosterLock } from "../helpers/reconcile";
import { addToCache, seedParentSettings, seedShape, stu } from "../helpers/roster-cache";
import { NO_CHANGES, appRecordsByCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";
import { holdLink, linkRows, mintLink, seedDevice } from "../helpers/signin-links";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); outbox.length = 0; await seedWorkingMail(); });

const [R_FAMILY, R_PARENT] = [RIVERA.family.qboId, RIVERA.parent.qboId];
const [C_FAMILY, C_PARENT] = [CHENOWETH.family.qboId, CHENOWETH.parent.qboId];
const NEW = "rosalind.moved@family-r-new.example";
const calls = () => stub.apiCalls().map((c) => `${c.method} ${c.path.replace(/^\/v3\/company\/\d+/, "")}`);
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const audits = async () => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).map((a) => ({ action: a.action, targetId: a.targetId, before: a.before, after: a.after }));
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0]!;
const person = async (id: string) => (await db.select().from(parent).where(eq(parent.id, id)))[0]!;
const sessionsOf = async (parentId: string) => db.select({ id: parentAuthSession.id }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId));
const codesOf = async (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const requests = () => db.select().from(parentEmailChange).orderBy(asc(parentEmailChange.createdAt));
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: null });
const copyOf = <T,>(value: T): T => structuredClone(value);
const asking = (email: unknown) => { const f = new FormData(); if (typeof email === "string") f.set("email", email); return requestEmailChangeAction(f); };
/** The token in the link mailed to `to`. */
const linkTo = (to: string) => {
  const mail = outbox.find((m) => m.to === to);
  if (!mail) throw new Error(`nothing was mailed to ${to}`);
  return /\/family\/email\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
};
const aCode = (parentId: string) => db.insert(signinCode).values({ parentId, codeHash: "an-unused-code", expiresAt: new Date(Date.now() + 600_000) });

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
    // Asked in the session's own family, the app's record: no QuickBooks id of the family is stored. The record it would
    // change is still QuickBooks'.
    expect(row).toMatchObject({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyId: r.identity.familyId, recordQboId: R_PARENT, newEmail: NEW, usedAt: null });
    expect(row).not.toHaveProperty("familyQboId");
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(token);
    expect(Math.abs(row!.expiresAt.getTime() - (Date.now() + 24 * 3_600_000))).toBeLessThan(60_000);
    // Asked, and audited without the token.
    const log = await audits();
    expect(log).toEqual([{ action: "parent.email.request", targetId: R_PARENT, before: { email: RIVERA.parent.email }, after: { email: NEW, familyId: String(r.identity.familyId) } }]);
    expect(JSON.stringify(log)).not.toContain(token);
    // Nothing else: QuickBooks isn't asked, the address and the session are as they were.
    expect(stub.calls).toHaveLength(0);
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
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual(Array.from({ length: 3 }, () => ["parent.email.request.failed", R_PARENT, { code: "not_proved" }]));
    // Proved just now: asked, as before.
    await proveRecently(r.identity);
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
    for (const bad of ["not an address", "", "a@", `${"x".repeat(320)}@example.com`]) expect(await asking(bad), bad).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    await db.delete(rateLimitEvent); // each ask is counted, a refused one too: these are more than an hour allows
    expect(await asking(undefined)).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    expect(await requestEmailChangeAction({ email: NEW } as unknown as FormData)).toEqual({ ok: false, errors: [EMAIL_COPY.invalid] });
    expect(await asking(` ${RIVERA.parent.email.toUpperCase()}`)).toEqual({ ok: false, errors: [EMAIL_COPY.same] });
    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it("tells a sign-in made by hand, a person in two families, and anyone while sign-ins are off to ask the club, and stores nothing", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });

    // Rivera's parent is also a parent of the Chenoweth family: changing one record would split the two.
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    asParent(r.identity);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });

    await seedParentSettings({ signin: false });
    asParent(c.identity);
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });

    expect(outbox).toEqual([]);
    expect(await requests()).toEqual([]);
    expect((await audits()).map((a) => [a.action, a.after])).toEqual([
      ["parent.email.request.failed", { code: "not_offered" }], ["parent.email.request.failed", { code: "not_offered" }], ["parent.email.request.failed", { code: "not_offered" }]]);
  });

  it("is rate-limited per person, and audits the first refusal only", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    for (let i = 0; i < 5; i++) expect(await asking(`try.${i}@family-r-new.example`)).toMatchObject({ ok: true });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyAsks] });
    expect(await asking(NEW)).toEqual({ ok: false, errors: [EMAIL_COPY.tooManyAsks] });
    expect((await audits()).filter((a) => a.action === "parent.email.request.failed")).toEqual([
      { action: "parent.email.request.failed", targetId: null, before: null, after: { code: "rate_limited" } }]);
  });
});

describe("the link's page", () => {
  it("asks, and opening it changes nothing", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    const page = await renderPage(ConfirmEmailPage, { params: { token } });
    expect(page).toContain(`Use ${NEW} to sign in from now on?`);
    expect(page).toContain("Yes, use this address");
    expect(stub.calls).toHaveLength(0);
    expect((await requests())[0]!.usedAt).toBeNull();
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
  });

  it("shows the words of an expired link for any other token, and nothing of it", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const theirs = await seedEmailChange({ parentId: c.identity.parentId, guardianId: c.identity.guardianId, familyQboId: C_FAMILY, recordQboId: C_PARENT, newEmail: "cordelia.moved@family-c-new.example" });
    asParent(r.identity);
    for (const token of [theirs.token, emailChangeToken(), "not-a-token", "../../etc"]) {
      const page = await renderPage(ConfirmEmailPage, { params: { token } });
      expect(page, token).toContain("This link has expired or has already been used.");
      expect(page, token).not.toContain("cordelia");
      expect(page, token).not.toContain("Yes, use this address");
    }
  });

  it("Family and the details page offer the change to a parent who may make it, and to nobody else", async () => {
    const { r } = await seedContactFamilies(stub);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(r.identity);
    expect(await renderPage(FamilyPage)).toContain(`<a class="btn btn-line" href="/family/email">Change my sign-in email</a>`);
    expect(await renderPage(FamilyDetailsPage)).toContain(`<a class="btn btn-line" href="/family/email">Change my sign-in email</a>`);
    // With no password, a link to choose one first; with one and no recent proof, asking again; then the new address.
    expect(await renderPage(FamilyEmailPage)).toContain("Email me a link to choose a password");
    await proveRecently(r.identity, PROVEN_PASSWORD, new Date(Date.now() - 11 * 60_000));
    const asksAgain = await renderPage(FamilyEmailPage);
    expect(asksAgain).toContain("Before you change your sign-in email, please show it&#x27;s you");
    expect(asksAgain).not.toContain("Send me a link");
    await proveRecently(r.identity);
    expect(await renderPage(FamilyEmailPage)).toContain("Send me a link");
    asParent(hand.identity);
    for (const page of [FamilyPage, FamilyDetailsPage]) expect(await renderPage(page)).not.toContain("Change my sign-in email");
    const told = await renderPage(FamilyEmailPage);
    expect(told).toContain("Your sign-in email can&#x27;t be changed here. Please ask the club and they&#x27;ll change it for you.");
    expect(told).not.toContain("Send me a link");
    await seedParentSettings({ signin: false });
    asParent(r.identity);
    expect(await renderPage(FamilyPage)).not.toContain("Change my sign-in email");
  });
});

describe("confirming: QuickBooks first, then the portal", () => {
  it("own Parent record: the one address is changed in QuickBooks, then the person, and the old address signs in nowhere", async () => {
    const { r, c } = await seedContactFamilies(stub);
    // Each link as it starts, with the version the portal last aligned with (stage 3's slice 9e).
    const linksBefore = await db.select().from(accountingLink).orderBy(asc(accountingLink.id));
    expect(linksBefore.filter((l) => l.syncedToken !== null && l.syncedAt !== null).length).toBeGreaterThan(0);
    await aCode(r.identity.parentId);
    // A set-up and a reset link mailed to the old address, a second set-up link held while its mail is on its way
    // there (the request page), and a device remembered for it.
    await mintLink(r.identity.parentId, "setup");
    await mintLink(r.identity.parentId, "reset");
    await holdLink(r.identity.parentId, "setup");
    await seedDevice(r.identity.parentId);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    const before = copyOf(stub.customers);
    // What the portal holds at the moment QuickBooks is written to: nothing has changed in it yet.
    let atTheWrite: unknown = null;
    stub.onApiRequest = async (call) => {
      if (call.method !== "POST") return;
      atTheWrite = { email: (await person(r.identity.parentId)).email, cached: (await cached(R_PARENT)).email, sessions: (await sessionsOf(r.identity.parentId)).length };
    };

    expect(await confirmEmailChangeAction(token)).toEqual({ ok: true, message: EMAIL_COPY.done(NEW), signedOut: true });
    expect(atTheWrite).toEqual({ email: RIVERA.parent.email, cached: RIVERA.parent.email, sessions: 1 });
    // One read of their own record, then the write of its email field alone, with the version just read.
    expect(calls()).toEqual([`GET /customer/${R_PARENT}`, "POST /customer"]);
    expect(JSON.parse(posts()[0]!.body)).toEqual({ Id: R_PARENT, SyncToken: "0", sparse: true, PrimaryEmailAddr: { Address: NEW } });
    const mine = inQuickBooks(stub, R_PARENT);
    const was = before.find((x) => x.Id === R_PARENT)!;
    expect(mine).toEqual({ ...was, PrimaryEmailAddr: { Address: NEW }, SyncToken: "1", MetaData: mine.MetaData });
    for (const other of before.filter((x) => x.Id !== R_PARENT)) expect(inQuickBooks(stub, other.Id as string)).toEqual(other);

    // Then the portal: the cache from QuickBooks' answer, and the person's own address, changed by the confirmation itself.
    expect(await cached(R_PARENT)).toMatchObject({ email: NEW, syncToken: "1" });
    expect(await person(r.identity.parentId)).toMatchObject({ email: NEW, name: RIVERA.parent.name });
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, r.identity.parentId)))[0]!.email).toBe(NEW);
    expect(await db.select({ status: guardian.status, sourceQboId: guardian.sourceQboId }).from(guardian).where(eq(guardian.parentId, r.identity.parentId))).toEqual([{ status: "active", sourceQboId: R_PARENT }]);
    // The old address signs in nowhere: no session, no code, no set-up or reset link, and no device remembered for it.
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect(await codesOf(r.identity.parentId)).toEqual([]);
    expect(await linkRows(r.identity.parentId)).toEqual([]);
    expect(await db.select().from(parentDevice).where(eq(parentDevice.parentId, r.identity.parentId))).toEqual([]);
    // The other family is untouched.
    expect(await sessionsOf(c.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    // Spent: the link works once.
    expect((await requests())[0]!.usedAt).not.toBeNull();
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });

    const saved = (await audits()).filter((a) => a.action === "parent.email.save");
    // One row says it all: the cache took QuickBooks' answer, and the person's address changed, signing them out.
    expect(saved).toEqual([{ action: "parent.email.save", targetId: R_PARENT, before: { email: RIVERA.parent.email, field: RIVERA.parent.email },
      after: { email: NEW, familyId: String(r.identity.familyId), field: NEW, portal: "cached", app: "changed", sessionsEnded: 1, linksDeleted: 3, devicesForgotten: 1 } }]);
    // Nothing decided access from QuickBooks: no sign-in was opened, moved or closed, and no address was changed by a rule.
    for (const action of ["parent.email.changed", "parent.access.granted", "parent.access.moved", "parent.access.ended", "parent.hold.opened"]) {
      expect((await audits()).map((a) => a.action)).not.toContain(action);
    }
    // The confirm changes none of the app's own records (stage 3's slice 9c): the sign-in is still in its family and
    // linked to its own record, as an import of the cache would leave them.
    const records = await appRecordsByCustomer();
    expect(records.memberships).toContainEqual({ guardianId: r.identity.guardianId, family: R_FAMILY });
    expect(records.links).toContainEqual(expect.objectContaining({ customer: R_PARENT, kind: "membership", guardianId: r.identity.guardianId }));
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    // Nor any link's version: the parent's own record is at version 1 in QuickBooks and the cache now, and every link,
    // its own included, holds the version and the time it held before (only a staff send aligns a link).
    expect(await db.select().from(accountingLink).orderBy(asc(accountingLink.id))).toEqual(linksBefore);
  });

  it("two presses of the button at once make one change, audited once", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    const results = await Promise.all([confirmEmailChangeAction(token), confirmEmailChangeAction(token)]);
    // One of them makes it; the other meets the change made, or QuickBooks' refusal of a version that has moved on.
    expect(results).toContainEqual({ ok: true, message: EMAIL_COPY.done(NEW), signedOut: true });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryEmailAddr: { Address: NEW }, SyncToken: "1" });
    expect((await audits()).filter((a) => a.action === "parent.email.save")).toHaveLength(1);
    expect((await person(r.identity.parentId)).email).toBe(NEW);
  });

  it("layered with no parent type: the family's field holds both parents' addresses, and only this parent's changes", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([{ qboId: "7310", displayName: "Noparent Family", typeQboId: "F", email: "home@noparent.example; Work@Noparent.example" }, stu("7311", "Nico Noparent", "7310")]);
    const home = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "7310" });
    const work = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "work@noparent.example", sourceQboId: "7310" });
    await connectCompany(stub);
    stub.customers = [qbCustomer("7310", "Noparent Family", { ...ofType("F"), PrimaryEmailAddr: { Address: "home@noparent.example; Work@Noparent.example" } }),
      qbCustomer("7311", "Nico Noparent", { ...under("7310"), ...ofType("S") })];
    asParent(home.identity);
    await proveRecently(home.identity);
    await asking("home.new@noparent.example");
    expect(await confirmEmailChangeAction(linkTo("home.new@noparent.example"))).toEqual({ ok: true, message: EMAIL_COPY.done("home.new@noparent.example"), signedOut: true });
    // Every other character of the field as it was: the other parent's address, its case, the separator.
    expect(JSON.parse(posts()[0]!.body)).toEqual({ Id: "7310", SyncToken: "0", sparse: true, PrimaryEmailAddr: { Address: "home.new@noparent.example; Work@Noparent.example" } });
    expect(await cached("7310")).toMatchObject({ email: "home.new@noparent.example; work@noparent.example", syncToken: "1" });
    expect((await person(home.identity.parentId)).email).toBe("home.new@noparent.example");
    expect(await sessionsOf(home.identity.parentId)).toEqual([]);
    // The other parent signs in as before.
    expect((await person(work.identity.parentId)).email).toBe("work@noparent.example");
    expect(await sessionsOf(work.identity.parentId)).toHaveLength(1);
  });

  it("flat: the member's own record", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "7410", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example" },
      { qboId: "7420", displayName: "Other Member", typeQboId: "M", email: "other@flat.example" }]);
    const m = await seedParentIn({ familyQboId: "7410", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "7410" });
    await connectCompany(stub);
    const other = qbCustomer("7420", "Other Member", { ...ofType("M"), PrimaryEmailAddr: { Address: "other@flat.example" } });
    stub.customers = [qbCustomer("7410", "Marisol Thackeray", { ...ofType("M"), PrimaryEmailAddr: { Address: "marisol@flat.example" } }), copyOf(other)];
    asParent(m.identity);
    await proveRecently(m.identity);
    await asking("marisol.new@flat.example");
    expect(await confirmEmailChangeAction(linkTo("marisol.new@flat.example"))).toEqual({ ok: true, message: EMAIL_COPY.done("marisol.new@flat.example"), signedOut: true });
    expect(inQuickBooks(stub, "7410").PrimaryEmailAddr).toEqual({ Address: "marisol.new@flat.example" });
    expect(inQuickBooks(stub, "7420")).toEqual(other);
    expect((await person(m.identity.parentId)).email).toBe("marisol.new@flat.example");
  });

  // One address is one person (app-owned families spec section 6): an address another person signs in with, whether
  // they are in another family or in none, is refused before anything is sent, in words that never say why.
  it.each([
    ["a guardian of another family", "other family"],
    ["a person in the portal with no family", "no family"],
  ] as const)("an address %s signs in with is refused before anything is sent, and nothing changes", async (_, who) => {
    const { r, c } = await seedContactFamilies(stub);
    const taken = who === "other family" ? CHENOWETH.parent.email : NEW;
    if (who === "no family") await seedParent({ name: "Somebody Else", email: NEW });
    await aCode(r.identity.parentId);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(taken);
    const token = linkTo(taken);
    stub.calls.length = 0;
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.cantHere] });
    expect(stub.apiCalls()).toEqual([]);
    expect(inQuickBooks(stub, R_PARENT).PrimaryEmailAddr).toEqual({ Address: RIVERA.parent.email });
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    expect(await sessionsOf(c.identity.parentId)).toHaveLength(1);
    // The link can never work: it is spent, and the refusal is recorded with its code, for staff.
    expect((await requests()).find((q) => q.newEmail === taken)!.usedAt).not.toBeNull();
    expect((await audits()).at(-1)).toMatchObject({ action: "parent.email.save.failed", targetId: R_PARENT, after: { code: "address_taken" } });
    // The words say nothing of another person, a family or why.
    expect(EMAIL_COPY.cantHere).not.toMatch(/family|another|already|taken|someone/i);
    expect(await db.select({ status: guardian.status }).from(guardian).where(eq(guardian.parentId, r.identity.parentId))).toEqual([{ status: "active" }]);
  });

  // Two links to one address confirmed at once: both pass the check, both reach QuickBooks, and the one that comes
  // second to the address locks finds the address held. Nothing can ever make it this person's, so nothing is promised.
  it("an address another person comes to hold while QuickBooks is written is not promised, and nobody is signed out", async () => {
    const { r } = await seedContactFamilies(stub);
    await aCode(r.identity.parentId);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    let other: string | null = null;
    stub.onApiRequest = async (call) => {
      if (call.method !== "POST" || other) return;
      other = (await seedParent({ name: "Somebody Else", email: NEW })).id;
    };
    const answer = await confirmEmailChangeAction(token);
    expect(answer).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    expect(other).not.toBeNull();
    // QuickBooks took it, and the cache follows QuickBooks; the person keeps the address they sign in with.
    expect(inQuickBooks(stub, R_PARENT).PrimaryEmailAddr).toEqual({ Address: NEW });
    expect((await cached(R_PARENT)).email).toBe(NEW);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
    expect((await person(other!)).email).toBe(NEW);
    // The audit row says QuickBooks holds the new address, for staff to put the record right.
    const saved = (await audits()).filter((a) => a.action === "parent.email.save");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.after).toMatchObject({ email: NEW, app: "address_taken", quickbooks: "holds_new_address" });
    expect((await requests()).find((q) => q.newEmail === NEW)!.usedAt).not.toBeNull();
  });

  // A second press of the same link, past the link check before the first spent it, finds the change made in QuickBooks
  // and the request spent by the first, which ended "taken": it is told as the first was, and signs nobody out.
  it("a second confirmation that races one that ended with the address taken is told the same, and nobody is signed out", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    await proveRecently(r.identity);
    await asking(NEW);
    const token = linkTo(NEW);
    let first: Promise<unknown> | null = null, other: string | null = null;
    stub.onApiRequest = async (call) => {
      if (call.method === "POST") { if (!other) other = (await seedParent({ name: "Somebody Else", email: NEW })).id; return; }
      // The second press's read of the record: the first press runs to its end before QuickBooks answers it.
      if (!first) { first = confirmEmailChangeAction(token); await first; }
    };
    const second = await confirmEmailChangeAction(token);
    expect(await first).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    expect(second).toEqual({ ok: false, errors: [EMAIL_COPY.askTheClub] });
    expect(posts()).toHaveLength(1);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect((await audits()).filter((a) => a.action === "parent.email.save")).toHaveLength(1);
  });
});

describe("confirming: what goes wrong changes nothing in the portal", () => {
  /** Rivera's parent has asked to change to NEW: the token, and what the portal held then. */
  const asked = async () => {
    const seeded = await seedContactFamilies(stub);
    await aCode(seeded.r.identity.parentId);
    asParent(seeded.r.identity);
    await proveRecently(seeded.r.identity);
    await asking(NEW);
    return { ...seeded, token: linkTo(NEW) };
  };
  const portalAsItWas = async (r: { identity: ParentIdentity }) => {
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await cached(R_PARENT)).toMatchObject({ email: RIVERA.parent.email, syncToken: "0" });
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect(await codesOf(r.identity.parentId)).toHaveLength(1);
  };

  it("a record changed in QuickBooks meanwhile: nothing is overwritten, and the link works again", async () => {
    const { r, token } = await asked();
    stub.beforeUpdate = (customer) => { customer.SyncToken = "1"; customer.DisplayName = "Rosalind R."; };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.changed] });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ DisplayName: "Rosalind R.", SyncToken: "1", PrimaryEmailAddr: { Address: RIVERA.parent.email } });
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).toBeNull();
    stub.beforeUpdate = null;
    expect(await confirmEmailChangeAction(token)).toMatchObject({ ok: true });
    expect(JSON.parse(posts().at(-1)!.body)).toMatchObject({ SyncToken: "1" });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ DisplayName: "Rosalind R.", PrimaryEmailAddr: { Address: NEW } });
  });

  it("refused by QuickBooks: nothing changes, and the link is spent", async () => {
    const { r, token } = await asked();
    stub.updateFault = "6000";
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.notAccepted] });
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).not.toBeNull();
    expect((await audits()).at(-1)).toMatchObject({ action: "parent.email.save.failed", targetId: R_PARENT, after: { code: "fault_6000" } });
  });

  it("an answer that never came: the parent is told the portal can't tell, and a later try that finds the change made follows it", async () => {
    const { r, token } = await asked();
    stub.loseUpdateAnswer = true;
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.unsure] });
    // QuickBooks made it; the portal doesn't know, and changed nothing.
    expect(inQuickBooks(stub, R_PARENT).PrimaryEmailAddr).toEqual({ Address: NEW });
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).toBeNull();
    stub.loseUpdateAnswer = false;
    const before = posts().length;
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: true, message: EMAIL_COPY.done(NEW), signedOut: true });
    expect(posts()).toHaveLength(before); // read, found made, and not sent again
    expect(await cached(R_PARENT)).toMatchObject({ email: NEW, syncToken: "1" });
    // The second try finished the portal's side: the app and QuickBooks agree, and the old address signs in nowhere.
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, r.identity.parentId)))[0]!.email).toBe(NEW);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect(await codesOf(r.identity.parentId)).toEqual([]);
    expect((await audits()).filter((a) => a.action === "parent.email.save").at(-1)).toMatchObject({ after: { portal: "cached", app: "changed" } });
  });

  it("a server error after the write: the same words, and nothing in the portal", async () => {
    const { r, token } = await asked();
    stub.updateServerFault = { status: 500, code: "10000" };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.unsure] });
    await portalAsItWas(r);
  });

  it("QuickBooks out of reach: nothing sent, and the link works again", async () => {
    const { r, token } = await asked();
    stub.dropApi = true;
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.tryLater] });
    expect(posts()).toEqual([]);
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).toBeNull();
  });

  it("another company connected: nothing is asked of it, and the link is kept", async () => {
    const { r, token } = await asked();
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    // The roster cache is another company's now, so the portal shows the family nothing, and has no record to change.
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    expect(stub.calls).toEqual([]);
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).toBeNull();
  });

  it("QuickBooks disconnected: nothing is sent, and the link works again", async () => {
    const { r, token } = await asked();
    await db.update(qboConnection).set({ refreshTokenCiphertext: null });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.tryLater] });
    expect(stub.calls).toEqual([]);
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).toBeNull();
  });

  it("the club took the address off the record: nothing is sent, and the parent is told the books changed", async () => {
    const { r, token } = await asked();
    inQuickBooks(stub, R_PARENT).PrimaryEmailAddr = { Address: "someone.else@family-r.example" };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.booksChanged] });
    expect(posts()).toEqual([]);
    await portalAsItWas(r);
    expect((await requests())[0]!.usedAt).not.toBeNull();
  });

  it("the new address is in the field beside the old one: nothing is sent", async () => {
    const { r, token } = await asked();
    inQuickBooks(stub, R_PARENT).PrimaryEmailAddr = { Address: `${RIVERA.parent.email}, ${NEW}` };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.cantHere] });
    expect(posts()).toEqual([]);
    await portalAsItWas(r);
  });

  it("the roster is busy: QuickBooks has the change, the person's address changes all the same, the cache is left alone and a refresh asked for", async () => {
    const { r, token } = await asked();
    const lock = await holdTheRosterLock();
    const result = await confirmMyEmailChange(ctxOf(r.identity), token, { lockWaitMs: 150 });
    await lock.release();
    // The sign-in address is the app's own: it changes without the roster, and the new address signs in at once.
    expect(result).toEqual({ ok: true, message: EMAIL_COPY.done(NEW), signedOut: true });
    expect(inQuickBooks(stub, R_PARENT).PrimaryEmailAddr).toEqual({ Address: NEW });
    expect(await cached(R_PARENT)).toMatchObject({ email: RIVERA.parent.email, syncToken: "0" });
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, r.identity.parentId)))[0]!.email).toBe(NEW);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect(await codesOf(r.identity.parentId)).toEqual([]);
    expect((await requests())[0]!.usedAt).not.toBeNull();
    expect(await rosterRefreshAsked()).toBe(true);
    expect((await audits()).at(-1)).toEqual({ action: "parent.email.save", targetId: R_PARENT, before: { email: RIVERA.parent.email, field: RIVERA.parent.email },
      after: { email: NEW, familyId: String(r.identity.familyId), field: NEW, portal: "refresh_asked", code: "busy", app: "changed", sessionsEnded: 1, linksDeleted: 0, devicesForgotten: 0 } });
  }, 30_000);

  it("a refresh that stored a later version while the confirmation waited keeps it: the answer's older one is not written over it", async () => {
    const { r, token } = await asked();
    const lock = await holdTheRosterLock();
    const confirming = confirmMyEmailChange(ctxOf(r.identity), token, { lockWaitMs: 10_000 });
    await untilALockIsAwaited();
    // The refresh holding the lock stores version 6: the club changed the field again in QuickBooks meanwhile.
    await db.update(qboCustomer).set({ email: "later.change@family-r.example", syncToken: "6" }).where(eq(qboCustomer.qboId, R_PARENT));
    await lock.release();
    expect((await confirming).ok).toBe(true);
    expect(await cached(R_PARENT)).toMatchObject({ email: "later.change@family-r.example", syncToken: "6" });
  }, 30_000);

  it("the company changed between the write and the cache: the cache is left alone, and the person's own address still changes", async () => {
    const { r, token } = await asked();
    stub.onApiRequest = async (call) => {
      if (call.method === "POST") await db.execute(sql`update setting set value = ${JSON.stringify({ realmId: "9130000000000999" })}::jsonb where key = ${SOURCE_KEY}`);
    };
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: true, message: EMAIL_COPY.done(NEW), signedOut: true });
    expect(await cached(R_PARENT)).toMatchObject({ email: RIVERA.parent.email });
    expect((await person(r.identity.parentId)).email).toBe(NEW);
    expect((await audits()).at(-1)).toMatchObject({ action: "parent.email.save", after: { portal: "refresh_asked", code: "other_company", app: "changed" } });
  });
});

describe("confirming with a token that isn't the session's own: one refusal, nothing sent, nothing changed", () => {
  it("family B's token, a token of family A's other parent, and junk", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const other = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    const tokens = {
      familyB: (await seedEmailChange({ parentId: c.identity.parentId, guardianId: c.identity.guardianId, familyQboId: C_FAMILY, recordQboId: C_PARENT, newEmail: "cordelia.moved@family-c-new.example" })).token,
      otherPerson: (await seedEmailChange({ parentId: other.identity.parentId, guardianId: other.identity.guardianId, familyQboId: R_FAMILY, recordQboId: R_PARENT, newEmail: "hand.moved@family-r-new.example" })).token,
      junk: "x".repeat(43), short: "abc", missing: emailChangeToken(),
    };
    const before = copyOf(stub.customers);
    const rows = await requests();
    asParent(r.identity);
    for (const [name, token] of Object.entries(tokens)) {
      expect(await confirmEmailChangeAction(token), name).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
      expect(await findMyEmailChange(ctxOf(r.identity), token), name).toEqual({ state: "gone" });
      expect(await renderPage(ConfirmEmailPage, { params: { token } }), name).not.toMatch(/cordelia|hand\.moved|Yes, use this address/);
    }
    // An argument that isn't a string at all.
    expect(await confirmEmailChangeAction({ token: tokens.familyB } as unknown as string)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });

    expect(stub.calls).toEqual([]);
    expect(stub.customers).toEqual(before);
    // Nothing of anyone else's request changed: B's and the other parent's are as they were, and unused.
    expect(await requests()).toEqual(rows);
    for (const p of [r, c, other]) expect(await sessionsOf(p.identity.parentId)).toHaveLength(1);
    expect((await person(c.identity.parentId)).email).toBe(CHENOWETH.parent.email);
    // The refusals are audited, and name nobody's record.
    expect((await audits()).filter((x) => x.action === "parent.email.save.failed").map((x) => [x.targetId, x.after]))
      .toEqual(Array.from({ length: 6 }, () => [null, { code: "bad_link" }]));
  });

  it("the session's own person, with a request that is expired, used, made under another family or link, or from before the link was kept", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const own = { parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyQboId: R_FAMILY, recordQboId: R_PARENT, newEmail: NEW };
    const variants: Record<string, Partial<Parameters<typeof seedEmailChange>[0]>> = {
      expired: { expiresAt: new Date(Date.now() - 1000) },
      used: { usedAt: new Date(Date.now() - 1000) },
      underAnotherFamily: { guardianId: c.identity.guardianId, familyQboId: C_FAMILY },
      // The session's own link, but asked in another family (the app's record of Chenoweth's family).
      inAnotherFamily: { familyQboId: C_FAMILY },
      inNoFamily: { familyQboId: null },
      underAnotherLink: { guardianId: c.identity.guardianId },
      fromBefore: { guardianId: null, familyQboId: null, recordQboId: null },
    };
    asParent(r.identity);
    for (const [name, variant] of Object.entries(variants)) {
      await db.delete(parentEmailChange);
      const { token } = await seedEmailChange({ ...own, ...variant });
      expect(await confirmEmailChangeAction(token), name).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
      expect(await findMyEmailChange(ctxOf(r.identity), token), name).toEqual({ state: "gone" });
    }
    expect(stub.calls).toEqual([]);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
  });

  it("a change asked in family A can't be confirmed from the same person's session in family B: refused as any other link, nothing sent, nothing changed", async () => {
    const { r } = await seedContactFamilies(stub);
    // Rivera's parent asks in the Rivera family, then is made a parent of the Chenoweth family too and signs in to it.
    asParent(r.identity);
    await proveRecently(r.identity);
    expect(await asking(NEW)).toMatchObject({ ok: true });
    const token = linkTo(NEW);
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: C_FAMILY, status: "active", sourceQboId: C_PARENT });
    await syncAppRecords();
    const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, r.identity.parentId));
    const inB = await identityNow((await seedParentSession(u!.id, { familyQboId: C_FAMILY })).id);
    expect(inB.familyId).not.toBe(r.identity.familyId);
    const before = copyOf(stub.customers);
    const rows = await requests();
    asParent(inB);
    expect(await findMyEmailChange(ctxOf(inB), token)).toEqual({ state: "gone" });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    expect(stub.calls).toEqual([]);
    expect(stub.customers).toEqual(before);
    // The request is as it was, unused and in family A; the person's address and sessions are as they were.
    expect(await requests()).toEqual(rows);
    expect(rows).toEqual([expect.objectContaining({ familyId: r.identity.familyId, usedAt: null })]);
    expect((await person(r.identity.parentId)).email).toBe(RIVERA.parent.email);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(2);
    expect((await audits()).filter((x) => x.action === "parent.email.save.failed").map((x) => x.after)).toEqual([{ code: "bad_link" }]);
  });

  it("a request that names a record not the session's own is refused, spent, and nothing is sent for either record", async () => {
    const { r } = await seedContactFamilies(stub);
    const before = copyOf(stub.customers);
    const { token } = await seedEmailChange({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyQboId: R_FAMILY, recordQboId: C_PARENT, newEmail: NEW });
    asParent(r.identity);
    expect(await findMyEmailChange(ctxOf(r.identity), token)).toEqual({ state: "gone" });
    expect(await confirmEmailChangeAction(token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    expect(stub.calls).toEqual([]);
    expect(stub.customers).toEqual(before);
    expect((await requests())[0]!.usedAt).not.toBeNull();
  });
});
