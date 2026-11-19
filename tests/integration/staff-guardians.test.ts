import { describe, it, expect, vi, beforeEach } from "vitest";

// Staff add, remove and reinstate a family's guardians, and change a person's name (stage 3's slice 7b of the
// app-owned families spec, section 6), in the portal only: nothing is sent to QuickBooks (no stub is started, and the
// families' ids are ones QuickBooks would never be asked about). Every write keeps the app's records in step.
const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.41" }), cookies: async () => ({ get: () => undefined }) }));
const revalidated = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: () => { revalidated.count += 1; } }));
// Mail is sent nowhere: only the tests that set mail up as working (seedWorkingMail()) send any, into this outbox.
type Msg = { to: string; subject: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, formWithdrawal, guardian, parent, parentAuthSession, parentAuthUser, role, roleAssignment, roleRule, student, type RequestSigner } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { enterableGuardianRows, lockEmail } from "@/lib/parents/sessions";
import { requestSigninCode } from "@/lib/parents/signin-codes";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { addGuardianAction, reinstateGuardianAction, removeGuardianAction, renamePersonAction } from "@/app/staff/(app)/parents/actions";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { NO_CHANGES, recordOfCustomer, whatAFreshRunWouldChange } from "../helpers/app-records";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedStaff, seedWorkingMail, untilALockIsAwaited } from "../helpers/db";
import { holdTheRosterLock } from "../helpers/reconcile";
import { seedCache, seedRosterRead, seedShape, seedParentSettings, storeShape, SIGNINS_ON, fam, par, stu } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";
import { formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";

const REALM = "9130000000000078";
const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
  fam("20", "Chen Family"), stu("22", "Mia Chen", "20"),
  fam("30", "Old Family", { active: false })];
const staffOp = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000003", label: "reg@club.org" }, ip: "203.0.113.41", permission: "Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const BROWSER = "That didn't go through. Reload the page and try again.";
const personOf = async (email: string) => (await db.select().from(parent).where(eq(parent.email, email)))[0];
const rowsOf = async (parentId: string) => db.select().from(guardian).where(eq(guardian.parentId, parentId)).orderBy(guardian.familyQboId);
const sessionsOf = async (authUserId: string) => db.select({ familyId: parentAuthSession.familyId }).from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));
const familyPage = async (customer: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id: String(await recordOfCustomer(customer, "family")) }) }));
const personPage = async (id: string) => renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id }) }));
/** The Portal sign-ins box alone, from its heading to the end of its section. */
const signinsBox = (html: string) => html.slice(html.indexOf('id="entry-signins-h"'), html.indexOf("</section>", html.indexOf('id="entry-signins-h"')));

describe("staff manage a family's guardians", () => {
  let registrar: Awaited<ReturnType<typeof seedStaff>>, reader: Awaited<ReturnType<typeof seedStaff>>;
  let rivera: AppFamilyId, chen: AppFamilyId;
  const as = (s: typeof registrar) => { who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email }; };
  beforeEach(async () => {
    revalidated.count = 0;
    outbox.length = 0;
    await resetDb();
    await seedRosterRead({ realmId: REALM });
    await seedShape(); await seedParentSettings(SIGNINS_ON);
    await seedCache(ALL);
    rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
    registrar = await seedStaff({ email: "reg@club.org", name: "Reg Istrar" });
    reader = await seedStaff({ email: "reader@club.org", name: "Rae Der" });
    const [parents] = await db.insert(role).values({ key: "parents", name: "Parents" }).returning();
    await db.insert(roleRule).values([{ roleId: parents!.id, kind: "include", pattern: "Parents.*" }, { roleId: parents!.id, kind: "include", pattern: "Roster.*" }]);
    await db.insert(roleAssignment).values({ roleId: parents!.id, staffUserId: registrar.id });
    const [roster] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: roster!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(roleAssignment).values({ roleId: roster!.id, staffUserId: reader.id });
    as(registrar);
  });

  describe("adding", () => {
    it("makes the person, their sign-in account and an invited row naming the family record and its customer, in step, audited", async () => {
      const r = await addGuardianAction(String(rivera), "  Ana   Rivera ", " Ana@Example.COM ");
      expect(r).toEqual({ ok: true, message: "Added Ana Rivera. They sign in with this address and a code while parent sign-ins are on, and are sent a welcome email if they have never had one and welcome emails are on." });
      const ana = (await personOf("ana@example.com"))!;
      expect(ana).toMatchObject({ name: "Ana Rivera", blocked: false, welcomeOwed: false });
      expect(await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id))).toEqual([expect.objectContaining({ name: "Ana Rivera", email: "ana@example.com", emailVerified: true })]);
      const [row] = await rowsOf(ana.id);
      expect(row).toMatchObject({ familyId: rivera, familyQboId: "10", sourceQboId: null, status: "invited", disabledReason: null });
      expect(await audits("parent.create")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: ana.id, ip: "203.0.113.41",
        after: { name: "Ana Rivera", email: "ana@example.com", familyId: String(rivera) } })]);
      expect(await audits("parent.access.granted")).toEqual([expect.objectContaining({ targetType: "guardian", targetId: row!.id, permission: "Parents.ReadWrite",
        after: { parentId: ana.id, familyId: String(rivera), familyQboId: "10", status: "invited", addedBy: "staff" } })]);
      // The records are in step: the row is in the family its column names, and nothing else would change.
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
      // Their row counts at once: sign-ins are on, and the family is active.
      expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
      expect(revalidated.count).toBe(1);
    });

    it("reuses the person who holds the address, name unchanged, for a second family; two adds at once make one person", async () => {
      await Promise.all([addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp), addGuardian(chen, { name: "A. Rivera-Chen", email: "ANA@example.com" }, staffOp)]);
      const people = await db.select().from(parent);
      expect(people).toHaveLength(1);
      expect(await db.select().from(parentAuthUser)).toHaveLength(1);
      expect((await rowsOf(people[0]!.id)).map((g) => [g.familyQboId, g.familyId, g.status])).toEqual([["10", rivera, "invited"], ["20", chen, "invited"]]);
      expect(await audits("parent.create")).toHaveLength(1);
      expect(await audits("parent.access.granted")).toHaveLength(2);
      expect(["Ana Rivera", "A. Rivera-Chen"]).toContain(people[0]!.name); // whichever add came first named them
      // Through the action, a third family's add says the person was there already and keeps their name.
      await seedCache([...ALL, fam("40", "Third Family")]);
      const third = await recordOfCustomer("40", "family");
      expect(await addGuardianAction(String(third), "Someone Else", "ana@example.com")).toEqual({ ok: true,
        message: `Added ${people[0]!.name}, who already had a sign-in with this address (their name is unchanged). They sign in with this address and a code while parent sign-ins are on, and are sent a welcome email if they have never had one and welcome emails are on.` });
      expect((await personOf("ana@example.com"))!.name).toBe(people[0]!.name);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("refuses in words, changing nothing: a bad name or address, a blocked person, an inactive family, a family with no link, one already a guardian", async () => {
      const blocked = await seedParent({ name: "Bea Blocked", email: "bea@example.com", blocked: true });
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const [unlinked] = await db.insert(family).values({ name: "Hand Family", active: true }).returning({ id: family.id });
      const before = { people: (await db.select().from(parent)).length, rows: (await db.select().from(guardian)).length, audit: (await db.select().from(auditLog)).length };
      const refused = async (familyId: string, name: string, email: string) => ((await addGuardianAction(familyId, name, email)) as { errors: string[] }).errors;
      expect(await refused(String(rivera), "  ", "new@example.com")).toEqual(["Give the guardian's name, up to 100 characters."]);
      expect(await refused(String(rivera), "x".repeat(101), "new@example.com")).toEqual(["Give the guardian's name, up to 100 characters."]);
      expect(await refused(String(rivera), "New Person", "not an address")).toEqual(["That isn't an email address the portal can send a sign-in code to. Check it and try again."]);
      expect(await refused(String(rivera), "Bea", "bea@example.com")).toEqual(["The person with this address is blocked. Unblock them on their page first."]);
      expect(await refused(String(await recordOfCustomer("30", "family")), "New Person", "new@example.com")).toEqual(["This family is inactive in the portal, so nobody can be added to it."]);
      expect(await refused(String(unlinked!.id), "New Person", "new@example.com")).toEqual(["This family has no customer in QuickBooks linked to it, so a guardian can't be added to it yet."]);
      expect(await refused(String(rivera), "Ana Again", "ana@example.com")).toEqual(["The person with this address is already one of this family's guardians."]);
      expect({ people: (await db.select().from(parent)).length, rows: (await db.select().from(guardian)).length, audit: (await db.select().from(auditLog)).length }).toEqual(before);
      expect((await personOf("bea@example.com"))!.id).toBe(blocked.id);
      expect(await db.select().from(guardian).where(eq(guardian.parentId, blocked.id))).toEqual([]);
    });

    it("reinstates the person's closed row in that family instead of making another, and says so", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const old = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "not_in_quickbooks", statusBeforeDisable: "active" });
      await seedCache(ALL); // the row in its family record, as a roster read leaves it
      expect(await addGuardianAction(String(rivera), "Ana Rivera", "ana@example.com")).toEqual({ ok: true,
        message: "Ana Rivera, who already had a sign-in with this address (their name is unchanged), was a guardian of this family before: their sign-in for it is back. They sign in with this address and a code while parent sign-ins are on." });
      expect(await rowsOf(ana.id)).toEqual([expect.objectContaining({ id: old.id, status: "active", disabledReason: null, statusBeforeDisable: null })]);
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: old.id, before: { status: "disabled", disabledReason: "not_in_quickbooks" },
        after: { parentId: ana.id, familyId: String(rivera), familyQboId: "10", status: "active", reinstated: true } });
      expect(await audits("parent.create")).toEqual([]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("takes a row a change of company closed under the same number as the new membership, as the unique index needs", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const old = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "99", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
      expect(await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp)).toMatchObject({ ok: true, outcome: "added", person: "existing", guardianId: old.id });
      expect(await rowsOf(ana.id)).toEqual([expect.objectContaining({ id: old.id, familyId: rivera, status: "invited", disabledReason: null, sourceQboId: null })]);
      expect((await audits("parent.access.granted"))[0]!.after).toMatchObject({ reopenedFrom: "company_changed", familyId: String(rivera) });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("owes a welcome while welcomes are on to someone never welcomed and not blocked, whether or not their row counts yet", async () => {
      await seedParentSettings({ welcome: true });
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      expect((await personOf("ana@example.com"))!.welcomeOwed).toBe(true);
      expect((await audits("parent.access.granted"))[0]!.after).toMatchObject({ welcomeOwed: true });
      // A family with no active student while the club asks for one: the row doesn't count yet, and the welcome is owed
      // all the same; the welcome job sends it once it does (hasRowThatCounts()).
      await storeShape(); await seedParentSettings({ requireActiveStudents: true });
      await db.update(student).set({ active: false }).where(eq(student.familyId, chen));
      await addGuardian(chen, { name: "Wen Chen", email: "wen@example.com" }, staffOp);
      const wen = (await personOf("wen@example.com"))!;
      expect(wen.welcomeOwed).toBe(true);
      expect(await enterableGuardianRows(wen.id)).toEqual([]);
      // Welcomed already, or with welcomes off: nothing owed.
      await db.update(parent).set({ welcomeOwed: false, welcomedAt: new Date() }).where(eq(parent.id, wen.id));
      await addGuardian(rivera, { name: "Wen Chen", email: "wen@example.com" }, staffOp);
      expect((await personOf("wen@example.com"))!.welcomeOwed).toBe(false);
      await seedParentSettings({ welcome: false });
      await addGuardian(rivera, { name: "Max", email: "max@example.com" }, staffOp);
      expect((await personOf("max@example.com"))!.welcomeOwed).toBe(false);
    });

    it("the welcome job skips an owed person whose row doesn't count yet, keeps them owed, and welcomes them once it does", async () => {
      await seedWorkingMail();
      await storeShape(); await seedParentSettings({ welcome: true, requireActiveStudents: true });
      await db.update(student).set({ active: false }).where(eq(student.familyId, chen));
      await addGuardian(chen, { name: "Wen Chen", email: "wen@example.com" }, staffOp);
      expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
      expect(outbox).toEqual([]);
      expect((await personOf("wen@example.com"))!).toMatchObject({ welcomeOwed: true, welcomedAt: null });
      // The family has an active student again: the row counts, and the next run sends the welcome, once.
      await db.update(student).set({ active: true }).where(eq(student.familyId, chen));
      expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
      expect(outbox.map((m) => m.to)).toEqual(["wen@example.com"]);
      expect((await personOf("wen@example.com"))!).toMatchObject({ welcomeOwed: false, welcomedAt: expect.any(Date) });
      expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    });

    it("lets nobody in before sign-ins are switched on, though the row is made", async () => {
      await seedParentSettings({ signin: false });
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      // The row is made and counts, but the door is closed until an Admin switches sign-ins on (parent-door.test.ts and
      // signin-codes.test.ts test the door itself); the add switches nothing on.
      expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
      expect(parentDoorClosed(await getParentSettings())).toBe(true);
      expect(await audits("settings.parents.save")).toEqual([]);
      // Asking for a code is refused for them, and nothing is mailed; once sign-ins are on, the code goes.
      await seedWorkingMail();
      await (await requestSigninCode("ana@example.com", "203.0.113.41")).delivery;
      expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "signins_off" }]);
      expect(outbox).toEqual([]);
      await seedParentSettings({ signin: true });
      await (await requestSigninCode("ana@example.com", "203.0.113.41")).delivery;
      expect((await audits("signin.code_sent")).map((r) => r.targetId)).toEqual([ana.id]);
      expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
    });

    it("waits for a roster read holding the lock, having written nothing, then adds", async () => {
      const lock = await holdTheRosterLock();
      const adding = addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      await untilALockIsAwaited();
      expect(await personOf("ana@example.com")).toBeUndefined();
      expect(await db.select().from(guardian)).toEqual([]);
      await lock.release();
      expect(await adding).toMatchObject({ ok: true, outcome: "added", person: "new" });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    }, 30_000);

    it("takes the person before the roster, as a parent's email confirm does, so a confirm under way and a staff write both go through", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [row] = await rowsOf(ana.id);
      // The confirm's order (email-change.ts, finish()): the address lock and the person's row, then the roster lock,
      // exclusively. Were a staff write to hold the roster while it waited for the person, Postgres would find the
      // cycle and abort one of the two.
      const confirmLike = async () => {
        let held!: () => void, go!: () => void;
        const isHeld = new Promise<void>((r) => { held = r; }), mayGo = new Promise<void>((r) => { go = r; });
        const done = db.transaction(async (tx) => {
          await lockEmail(tx, "ana@example.com");
          await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ana.id)).for("update");
          held(); await mayGo;
          await tx.execute(sql`set local lock_timeout = '10s'`);
          await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
        });
        await isHeld;
        return { go, done };
      };
      const writes = [() => removeGuardian(row!.id, "Moved away.", staffOp), () => reinstateGuardian(row!.id, staffOp),
        () => addGuardian(chen, { name: "Ana Rivera", email: "ana@example.com" }, staffOp)];
      for (const write of writes) {
        const confirm = await confirmLike();
        const staff = write();
        await untilALockIsAwaited();
        confirm.go();
        await confirm.done;
        expect((await staff).ok).toBe(true);
      }
      expect((await rowsOf(ana.id)).map((g) => [g.familyQboId, g.status])).toEqual([["10", "invited"], ["20", "invited"]]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    }, 60_000);
  });

  describe("removing", () => {
    const signer = (parentId: string, name: string): RequestSigner => ({ parentId, recipientId: 1, name, email: `${name.toLowerCase()}@example.com`, signedAt: null });

    it("closes the row as removed with a note for staff only, ends that family's sessions, starts its waiting forms again, in step", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      await addGuardian(chen, { name: "Ana", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [user] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id));
      await seedParentSession(user!.id, { familyId: rivera }); await seedParentSession(user!.id, { familyId: chen });
      const s = await seedSeason({ name: "2026-27", steps: [{ name: "Sign-up" }] });
      const req = await seedFormRequirement({ stepId: s.stepIds["Sign-up"]!, title: "Commitment form", appliesTo: "family", form: formSetting({ id: "envelope_t1" }) });
      const waiting = await seedRequest({ requirementId: req, familyQboId: "10", subjectQboId: "10", state: "waiting", envelopeId: "envelope_rivera", signers: [signer(ana.id, "Ana")] });
      const [row] = await db.select().from(guardian).where(and(eq(guardian.parentId, ana.id), eq(guardian.familyQboId, "10")));

      expect(await removeGuardianAction(row!.id, "  ")).toEqual({ ok: false, errors: ["Say why, in a few words. Only staff see it."] });
      expect(await removeGuardianAction(row!.id, "Custody order on file.")).toEqual({ ok: true, message: "Removed. They can't sign in to this family any more, and are signed out of it." });
      expect((await rowsOf(ana.id)).map((g) => [g.familyQboId, g.status, g.disabledReason, g.statusBeforeDisable])).toEqual([["10", "disabled", "removed", "invited"], ["20", "invited", null, null]]);
      expect(await sessionsOf(user!.id)).toEqual([{ familyId: chen }]);
      expect(await requestNow(waiting)).toMatchObject({ state: "not_opened", envelopeId: null });
      expect((await db.select().from(formWithdrawal)).map((w) => w.envelopeId)).toEqual(["envelope_rivera"]);
      expect(await audits("parent.access.ended")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetId: row!.id, ip: "203.0.113.41",
        after: expect.objectContaining({ parentId: ana.id, familyId: String(rivera), reason: "removed", sessionsEnded: 1, formsReset: 1, note: "Custody order on file." }) })]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
      // Removed already: nothing changes, and nothing is recorded again.
      expect(await removeGuardianAction(row!.id, "Again.")).toEqual({ ok: true, message: "This guardian can't sign in to this family already." });
      expect(await audits("parent.access.ended")).toHaveLength(1);
      // The last open row: every session ends.
      const [other] = await db.select().from(guardian).where(and(eq(guardian.parentId, ana.id), eq(guardian.familyQboId, "20")));
      await seedParentSession(user!.id);
      expect(await removeGuardian(other!.id, "Moved away.", staffOp)).toEqual({ ok: true, sessionsEnded: 2 });
      expect(await sessionsOf(user!.id)).toEqual([]);
      expect(await enterableGuardianRows(ana.id)).toEqual([]);
    });

    it("never shows the note on a staff page, and refuses an id no page sends", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [row] = await rowsOf(ana.id);
      await removeGuardian(row!.id, "A note only the audit log keeps.", staffOp);
      expect(await familyPage("10")).not.toContain("A note only the audit log keeps.");
      expect(await personPage(ana.id)).not.toContain("A note only the audit log keeps.");
      const loose = (f: unknown) => f as (...a: unknown[]) => Promise<unknown>;
      for (const bad of ["not-an-id", "x".repeat(65), null, { id: row!.id }, "00000000-0000-4000-8000-00000000dead"]) {
        expect(await loose(removeGuardianAction)(bad, "note")).toEqual({ ok: false, errors: [BROWSER] });
        expect(await loose(reinstateGuardianAction)(bad)).toEqual({ ok: false, errors: [BROWSER] });
      }
      expect(await loose(removeGuardianAction)(row!.id, "x".repeat(2001))).toEqual({ ok: false, errors: [BROWSER] });
      for (const bad of ["not-an-id", String(await recordOfCustomer("12", "student")), "00000000-0000-4000-8000-00000000dead", 10]) {
        expect(await loose(addGuardianAction)(bad, "New", "new@example.com")).toEqual({ ok: false, errors: [BROWSER] });
      }
      expect(await loose(addGuardianAction)(String(rivera), ["New"], "new@example.com")).toEqual({ ok: false, errors: [BROWSER] });
      expect(await loose(addGuardianAction)(String(rivera), "New", "x".repeat(321))).toEqual({ ok: false, errors: [BROWSER] });
      expect(await personOf("new@example.com")).toBeUndefined();
    });
  });

  describe("reinstating", () => {
    it("opens the same row again as it was, owes a welcome when due, in step", async () => {
      await seedParentSettings({ welcome: true });
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const old = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "held", statusBeforeDisable: "active" });
      await seedCache(ALL);
      expect(await reinstateGuardianAction(old.id)).toEqual({ ok: true, message: "Reinstated. Their sign-in for this family is back." });
      expect(await rowsOf(ana.id)).toEqual([expect.objectContaining({ id: old.id, status: "active", disabledReason: null, sourceQboId: "11" })]);
      expect((await personOf("ana@example.com"))!.welcomeOwed).toBe(true);
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: old.id, permission: "Parents.ReadWrite",
        before: { status: "disabled", disabledReason: "held" }, after: { familyId: String(rivera), status: "active", reinstated: true, welcomeOwed: true } });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
      expect(await reinstateGuardianAction(old.id)).toEqual({ ok: true, message: "This guardian's sign-in for this family is open already." });
      expect(await audits("parent.access.granted")).toHaveLength(1);
    });

    it("a row staff removed comes back invited when it was never used", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      const [row] = await rowsOf((await personOf("ana@example.com"))!.id);
      await removeGuardian(row!.id, "By mistake.", staffOp);
      expect(await reinstateGuardian(row!.id, staffOp)).toEqual({ ok: true });
      expect((await db.select().from(guardian).where(eq(guardian.id, row!.id)))[0]).toMatchObject({ status: "invited", disabledReason: null });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("refuses a previous company's row, a blocked person and an inactive family, in words, changing nothing", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const previous = await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
      const inactive = await seedGuardian({ parentId: ana.id, familyQboId: "30", status: "disabled", disabledReason: "family_inactive", statusBeforeDisable: "active" });
      const held = await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      const errors = async (id: string) => ((await reinstateGuardianAction(id)) as { errors: string[] }).errors;
      expect(await errors(previous.id)).toEqual(["This sign-in was from a different QuickBooks company, so it can't be brought back."]);
      expect(await errors(inactive.id)).toEqual(["This family is inactive in the portal, so nobody can sign in to it."]);
      await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
      expect(await errors(held.id)).toEqual(["This person is blocked. Unblock them on their page first."]);
      expect((await rowsOf(ana.id)).every((g) => g.status === "disabled")).toBe(true);
      expect(await audits("parent.access.granted")).toEqual([]);
    });

    it("refuses a family with no link, and a row naming a customer other than its family's own, in words, changing nothing", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const held = await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
      const other = await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      // A row in Rivera's record that names Chen's customer: not this family's row to reopen.
      await db.update(guardian).set({ familyId: rivera }).where(eq(guardian.id, other.id));
      const NO_LINK = "This family has no customer in QuickBooks linked to it, so this sign-in can't be brought back yet.";
      const errors = async (id: string) => ((await reinstateGuardianAction(id)) as { errors: string[] }).errors;
      expect(await errors(other.id)).toEqual([NO_LINK]);
      await db.delete(accountingLink).where(eq(accountingLink.familyId, rivera));
      expect(await errors(held.id)).toEqual([NO_LINK]);
      expect((await rowsOf(ana.id)).every((g) => g.status === "disabled")).toBe(true);
      expect(await audits("parent.access.granted")).toEqual([]);
    });
  });

  describe("a person's name", () => {
    it("changes the person and their sign-in account together, audited with before and after; the same name changes nothing", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      expect(await renamePersonAction(ana.id, "  Ana   Rivera-Lopez ")).toEqual({ ok: true, message: "Saved. Their name is changed in the portal." });
      expect((await personOf("ana@example.com"))!.name).toBe("Ana Rivera-Lopez");
      expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id)))[0]!.name).toBe("Ana Rivera-Lopez");
      expect(await audits("parent.name.changed")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: ana.id,
        before: { name: "Ana Rivera" }, after: { name: "Ana Rivera-Lopez" } })]);
      expect(await renamePersonAction(ana.id, "Ana Rivera-Lopez")).toEqual({ ok: true, message: "That is their name already." });
      expect(await renamePersonAction(ana.id, " ")).toEqual({ ok: false, errors: ["Give their name, up to 100 characters."] });
      expect(await renamePersonAction("00000000-0000-4000-8000-00000000dead", "Someone")).toEqual({ ok: false, errors: ["That person isn't in the portal any more."] });
      expect(await renamePerson(ana.id, "Line\u0007Bell", staffOp)).toEqual({ ok: false, reason: "invalid" });
      expect(await audits("parent.name.changed")).toHaveLength(1);
    });
  });

  describe("the pages and who may act", () => {
    it("every action is refused without Parents.ReadWrite", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [row] = await rowsOf(ana.id);
      as(reader);
      await expect(addGuardianAction(String(rivera), "Zed", "zed@example.com")).rejects.toBeInstanceOf(AccessDenied);
      await expect(removeGuardianAction(row!.id, "note")).rejects.toBeInstanceOf(AccessDenied);
      await expect(reinstateGuardianAction(row!.id)).rejects.toBeInstanceOf(AccessDenied);
      await expect(renamePersonAction(ana.id, "Zed")).rejects.toBeInstanceOf(AccessDenied);
      expect(await personOf("zed@example.com")).toBeUndefined();
    });

    it("the family's box offers remove, reinstate and add to Parents.ReadWrite only, and says why a family takes nobody", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const sam = await seedParent({ name: "Sam Shared", email: "sam@example.com" });
      await seedGuardian({ parentId: sam.id, familyQboId: "10", status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      const box = signinsBox(await familyPage("10"));
      expect(box).toContain('Remove<span class="visually-hidden"> Ana Rivera</span>');
      expect(box).toContain("Reinstate Sam Shared");
      expect(box).toContain("Can&#x27;t sign in: removed by staff");
      expect(box).toContain("Add a guardian");
      expect(box).toContain("Email address they sign in with");
      const inactive = signinsBox(await familyPage("30"));
      expect(inactive).toContain("This family is inactive in the portal, so nobody can be added to it.");
      expect(inactive).not.toContain("Add guardian<");
      as(reader);
      const plain = signinsBox(await familyPage("10"));
      expect(plain).toContain("Ana Rivera");
      for (const gone of ["Remove", "Reinstate", "Add a guardian"]) expect(plain).not.toContain(gone);
    });

    it("the person's page lists their families with the same actions, and has the name form", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      await addGuardian(chen, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [, inChen] = await rowsOf(ana.id);
      await removeGuardian(inChen!.id, "Not hers.", staffOp);
      const html = await personPage(ana.id);
      expect(html).toContain('Remove<span class="visually-hidden"> Rivera Family</span>');
      expect(html).toContain("Reinstate Chen Family");
      expect(html).toContain('id="pn-h">Name</h2>');
      expect(html).toContain('value="Ana Rivera"');
    });
  });
});
