import { describe, it, expect, vi, beforeEach } from "vitest";

// Staff add, remove and reinstate a family's guardians, and change a person's name (stage 3's slice 7b of the
// app-owned families spec, section 6), in the portal only: nothing is sent to QuickBooks (no stub is started, and the
// families' ids are ones QuickBooks would never be asked about). Every write keeps the app's records in step. Adding,
// removing and reinstating take Roster.Family.ReadWrite (they give or end an address's sign-in for a family: the
// lead's choice); a name, like blocking, takes Parents.ReadWrite.
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
import { accountingLink, auditLog, family, formWithdrawal, guardian, parent, parentAuthSession, parentAuthUser, parentEmailChange, role, roleAssignment, roleRule, signinCode, student, type RequestSigner } from "@/lib/db/schema";
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
import { seedEmailChange } from "../helpers/email-change";
import { holdTheRosterLock } from "../helpers/reconcile";
import { seedCache, seedRosterRead, seedShape, seedParentSettings, storeShape, SIGNINS_ON, fam, par, stu } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";
import { formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";

const REALM = "9130000000000078";
const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
  fam("20", "Chen Family"), stu("22", "Mia Chen", "20"),
  fam("30", "Old Family", { active: false })];
const R = "Roster.Family.ReadWrite";
const staffOp = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000003", label: "reg@club.org" }, ip: "203.0.113.41", permission: R };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const BROWSER = "That didn't go through. Reload the page and try again.";
const BUSY = "The roster is being read from QuickBooks just now, so nothing was changed. Try again in a minute.";
const personOf = async (email: string) => (await db.select().from(parent).where(eq(parent.email, email)))[0];
const rowsOf = async (parentId: string) => db.select().from(guardian).where(eq(guardian.parentId, parentId)).orderBy(guardian.familyQboId);
const sessionsOf = async (authUserId: string) => db.select({ familyId: parentAuthSession.familyId }).from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));
const familyPage = async (customer: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id: String(await recordOfCustomer(customer, "family")) }) }));
const personPage = async (id: string) => renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id }) }));
/** The Portal sign-ins box alone, from its heading to the end of its section. */
const signinsBox = (html: string) => html.slice(html.indexOf('id="entry-signins-h"'), html.indexOf("</section>", html.indexOf('id="entry-signins-h"')));
/** The person's Families box alone. */
const familiesBox = (html: string) => html.slice(html.indexOf('id="pf-h"'), html.indexOf("</section>", html.indexOf('id="pf-h"')));
/** What a write could have changed: people, rows, audit rows and owed welcomes, counted. */
const counts = async () => ({ people: (await db.select().from(parent)).length, rows: (await db.select().from(guardian)).length,
  audit: (await db.select().from(auditLog)).length, owed: (await db.select().from(parent)).filter((p) => p.welcomeOwed).length });
/** Adds a person who holds the address already, as the second press does: carrying their id as the page was shown it. */
const addKnown = async (familyId: AppFamilyId, name: string, email: string) => addGuardian(familyId, { name, email, samePerson: (await personOf(email))!.id }, staffOp);

describe("staff manage a family's guardians", () => {
  type Staff = Awaited<ReturnType<typeof seedStaff>>;
  let registrar: Staff, parentsOnly: Staff, rosterWriter: Staff, reader: Staff;
  let rivera: AppFamilyId, chen: AppFamilyId;
  const as = (s: Staff) => { who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email }; };
  /** A staff member holding a role with these rules, each an exact permission or a pattern. */
  const staffWith = async (email: string, rules: string[]): Promise<Staff> => {
    const s = await seedStaff({ email, name: email });
    const [r] = await db.insert(role).values({ key: email.split("@")[0]!, name: email }).returning();
    await db.insert(roleRule).values(rules.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    return s;
  };
  beforeEach(async () => {
    revalidated.count = 0;
    outbox.length = 0;
    await resetDb();
    await seedRosterRead({ realmId: REALM });
    await seedShape(); await seedParentSettings(SIGNINS_ON);
    await seedCache(ALL);
    rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
    registrar = await staffWith("reg@club.org", ["Parents.*", "Roster.*"]);
    parentsOnly = await staffWith("parents@club.org", ["Parents.ReadWrite", "Roster.Read"]);
    rosterWriter = await staffWith("roster@club.org", ["Roster.*"]);
    reader = await staffWith("reader@club.org", ["Roster.Read"]);
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
      expect(await audits("parent.create")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: R, targetType: "parent", targetId: ana.id, ip: "203.0.113.41",
        after: { name: "Ana Rivera", email: "ana@example.com", familyId: String(rivera) } })]);
      // The grant records the permission used, that the person is new, and the name as staff typed it, tidied.
      expect(await audits("parent.access.granted")).toEqual([expect.objectContaining({ targetType: "guardian", targetId: row!.id, permission: R,
        after: { parentId: ana.id, familyId: String(rivera), familyQboId: "10", status: "invited", addedBy: "staff", person: "new", typedName: "Ana Rivera" } })]);
      // The records are in step: the row is in the family its column names, and nothing else would change.
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
      // Their row counts at once: sign-ins are on, and the family is active.
      expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
      expect(revalidated.count).toBe(1);
    });

    it("two adds of one new address at once make one person: the second is asked about them, and writes nothing", async () => {
      const results = await Promise.all([addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp), addGuardian(chen, { name: "A. Rivera-Chen", email: "ANA@example.com" }, staffOp)]);
      const people = await db.select().from(parent);
      expect(people).toHaveLength(1);
      expect(await db.select().from(parentAuthUser)).toHaveLength(1);
      expect(await audits("parent.create")).toHaveLength(1);
      expect(await audits("parent.access.granted")).toHaveLength(1);
      const firstWon = results[0]!.ok;
      expect(results[firstWon ? 0 : 1]).toMatchObject({ ok: true, outcome: "added", person: "new" });
      expect(results[firstWon ? 1 : 0]).toEqual({ ok: false, reason: "same_person", person: { id: people[0]!.id, name: people[0]!.name, families: [firstWon ? "Rivera Family" : "Chen Family"] } });
      expect((await rowsOf(people[0]!.id)).map((g) => g.familyId)).toEqual([firstWon ? rivera : chen]);
    });

    it("an address someone holds changes nothing at the first press: staff are shown who it is; the second press, naming them, adds them under their own name", async () => {
      await seedParentSettings({ welcome: true });
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "active" });
      await seedCache([...ALL, fam("40", "Third Family")]); // her row in Chen's record, as a roster read leaves it
      const before = await counts();
      const first = await addGuardianAction(String(rivera), "Someone Else", " ANA@example.com");
      expect(first).toEqual({ ok: false, samePerson: ana.id, errors: [
        "This address already belongs to Ana Rivera, a guardian of Chen Family. Nothing has been changed yet. If this is the same person, press \"Yes, add them\": they are added under the name they have. If not, check the address."] });
      // Nothing written: no row, no audit row, no welcome owed, and the page isn't drawn again.
      expect(await counts()).toEqual(before);
      expect(revalidated.count).toBe(0);
      // The second press carries the person as shown.
      expect(await addGuardianAction(String(rivera), "Someone Else", "ana@example.com", ana.id)).toEqual({ ok: true,
        message: "Added Ana Rivera, who already had a sign-in with this address (their name is unchanged). They sign in with this address and a code while parent sign-ins are on, and are sent a welcome email if they have never had one and welcome emails are on." });
      expect((await personOf("ana@example.com"))!).toMatchObject({ name: "Ana Rivera", welcomeOwed: true });
      expect((await rowsOf(ana.id)).map((g) => [g.familyQboId, g.status])).toEqual([["10", "invited"], ["20", "active"]]);
      expect(await audits("parent.create")).toEqual([]);
      expect((await audits("parent.access.granted")).map((a) => a.after)).toEqual([expect.objectContaining({ familyId: String(rivera), person: "existing", typedName: "Someone Else", welcomeOwed: true })]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
      // In two families now, both are named, by name.
      const third = await recordOfCustomer("40", "family");
      expect(((await addGuardianAction(String(third), "Ana", "ana@example.com")) as { errors: string[] }).errors[0])
        .toContain("belongs to Ana Rivera, a guardian of Chen Family and Rivera Family.");
    });

    it("a second press naming anyone but who holds the address now is asked again, changing nothing", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const bea = await seedParent({ name: "Bea Other", email: "bea@example.com" });
      const before = await counts();
      // The page was shown Bea for this address (it belonged to her then); it is Ana's now.
      expect(await addGuardianAction(String(rivera), "Ana", "ana@example.com", bea.id)).toEqual({ ok: false, samePerson: ana.id, errors: [
        "This address already belongs to Ana Rivera, who isn't a guardian of any family now. Nothing has been changed yet. If this is the same person, press \"Yes, add them\": they are added under the name they have. If not, check the address."] });
      expect(await addGuardian(rivera, { name: "Ana", email: "ana@example.com", samePerson: bea.id }, staffOp)).toMatchObject({ ok: false, reason: "same_person", person: { id: ana.id } });
      expect(await counts()).toEqual(before);
      // A person's id no page sends is refused before anything is read.
      expect(await addGuardianAction(String(rivera), "Ana", "ana@example.com", "not-an-id")).toEqual({ ok: false, errors: [BROWSER] });
    });

    it("refuses in words, changing nothing: a bad name or address, a blocked person, an inactive family, one already a guardian", async () => {
      const blocked = await seedParent({ name: "Bea Blocked", email: "bea@example.com", blocked: true });
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const before = await counts();
      const refused = async (familyId: string, name: string, email: string) => ((await addGuardianAction(familyId, name, email)) as { errors: string[] }).errors;
      expect(await refused(String(rivera), "  ", "new@example.com")).toEqual(["Give the guardian's name, up to 100 characters."]);
      expect(await refused(String(rivera), "x".repeat(101), "new@example.com")).toEqual(["Give the guardian's name, up to 100 characters."]);
      expect(await refused(String(rivera), "New Person", "not an address")).toEqual(["That isn't an email address the portal can send a sign-in code to. Check it and try again."]);
      expect(await refused(String(rivera), "Bea", "bea@example.com")).toEqual(["The person with this address is blocked. Unblock them on their page first."]);
      expect(await refused(String(await recordOfCustomer("30", "family")), "New Person", "new@example.com")).toEqual(["This family is inactive in the portal, so nobody can be added to it."]);
      // Already one of the family's guardians: said at once, with no question first.
      expect(await refused(String(rivera), "Ana Again", "ana@example.com")).toEqual(["The person with this address is already one of this family's guardians."]);
      expect(await counts()).toEqual(before);
      expect((await personOf("bea@example.com"))!.id).toBe(blocked.id);
      expect(await db.select().from(guardian).where(eq(guardian.parentId, blocked.id))).toEqual([]);
    });

    it("adds a guardian to a family with no link (stage 3's slice 9d): a row naming no customer, never given one later; a row made once it is linked names its customer", async () => {
      const [hand] = await db.insert(family).values({ name: "Hand Family", active: true }).returning({ id: family.id });
      expect(await addGuardianAction(String(hand!.id), "Hal Hand", "hal@example.com")).toMatchObject({ ok: true });
      const hal = (await personOf("hal@example.com"))!;
      const [row] = await rowsOf(hal.id);
      expect(row).toMatchObject({ familyId: hand!.id, familyQboId: null, sourceQboId: null, status: "invited" });
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: row!.id, after: { familyId: String(hand!.id), familyQboId: null, status: "invited", person: "new" } });
      // The person is in the family once: a second add of them is refused as one already there.
      expect(await addGuardian(hand!.id, { name: "Hal", email: "hal@example.com", samePerson: hal.id }, staffOp)).toEqual({ ok: false, reason: "already" });
      // Their row counts at the gate: an open row in an active family record, link or none.
      expect((await enterableGuardianRows(hal.id)).map((g) => g.familyId)).toEqual([hand!.id]);
      // Linked later, as "Create in QuickBooks and link" links it: the row is never given a customer, and a new row names it.
      await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "40", familyId: hand!.id, origin: "created" });
      expect(await addGuardian(hand!.id, { name: "Ivy Hand", email: "ivy@example.com" }, staffOp)).toMatchObject({ ok: true, outcome: "added" });
      expect((await rowsOf(hal.id))[0]).toMatchObject({ id: row!.id, familyQboId: null });
      expect((await rowsOf((await personOf("ivy@example.com"))!.id))[0]).toMatchObject({ familyId: hand!.id, familyQboId: "40" });
      // Removed and reinstated: the row that names no customer comes back as it was.
      expect(await removeGuardian(row!.id, "Moved away.", staffOp)).toMatchObject({ ok: true });
      expect(await reinstateGuardian(row!.id, staffOp)).toEqual({ ok: true });
      expect((await rowsOf(hal.id))[0]).toMatchObject({ id: row!.id, familyQboId: null, status: "invited", disabledReason: null });
      // Its audit row names the customer the row names (none), not the family's link made since.
      const reinstated = (await audits("parent.access.granted")).filter((a) => a.targetId === row!.id && (a.after as { reinstated?: boolean }).reinstated === true);
      expect(reinstated).toEqual([expect.objectContaining({ after: expect.objectContaining({ familyId: String(hand!.id), familyQboId: null }) })]);
    });

    it("a person's page links a family with no link while its record is active, and not once it is made inactive in the portal: its page is gone", async () => {
      const [hand] = await db.insert(family).values({ name: "Hand Family", active: true }).returning({ id: family.id });
      expect(await addGuardianAction(String(hand!.id), "Hal Hand", "hal@example.com")).toMatchObject({ ok: true });
      const hal = (await personOf("hal@example.com"))!;
      const href = `href="/staff/roster/${hand!.id}"`;
      expect(familiesBox(await personPage(hal.id))).toContain(href);
      await db.update(family).set({ active: false }).where(eq(family.id, hand!.id));
      const html = familiesBox(await personPage(hal.id));
      expect(html).toContain("Hand Family");
      expect(html).not.toContain(href);
      await expect(RosterEntryPage({ params: Promise.resolve({ id: String(hand!.id) }) })).rejects.toMatchObject({ notFound: true });
    });

    it("reinstates the person's closed row in that family instead of making another, once staff say it is them, and says so", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const old = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "not_in_quickbooks", statusBeforeDisable: "active" });
      await seedCache(ALL); // the row in its family record, as a roster read leaves it
      expect(await addGuardianAction(String(rivera), "Ana Rivera", "ana@example.com")).toMatchObject({ ok: false, samePerson: ana.id });
      expect((await rowsOf(ana.id))[0]).toMatchObject({ status: "disabled" });
      expect(await addGuardianAction(String(rivera), "Ana R.", "ana@example.com", ana.id)).toEqual({ ok: true,
        message: "Ana Rivera, who already had a sign-in with this address (their name is unchanged), was a guardian of this family before: their sign-in for it is back. They sign in with this address and a code while parent sign-ins are on." });
      expect(await rowsOf(ana.id)).toEqual([expect.objectContaining({ id: old.id, status: "active", disabledReason: null, statusBeforeDisable: null })]);
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: old.id, permission: R, before: { status: "disabled", disabledReason: "not_in_quickbooks" },
        after: { parentId: ana.id, familyId: String(rivera), familyQboId: "10", status: "active", reinstated: true, addedBy: "staff", person: "existing", typedName: "Ana R." } });
      expect(await audits("parent.create")).toEqual([]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("takes a row a change of company closed under the same number as the new membership, as the unique index needs", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const old = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "99", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
      expect(await addKnown(rivera, "Ana Rivera", "ana@example.com")).toMatchObject({ ok: true, outcome: "added", person: "existing", guardianId: old.id });
      expect(await rowsOf(ana.id)).toEqual([expect.objectContaining({ id: old.id, familyId: rivera, status: "invited", disabledReason: null, sourceQboId: null })]);
      expect((await audits("parent.access.granted"))[0]!.after).toMatchObject({ reopenedFrom: "company_changed", familyId: String(rivera), person: "existing" });
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
      expect(await addKnown(rivera, "Wen Chen", "wen@example.com")).toMatchObject({ ok: true });
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

    it("waits within its bound for a roster read holding the lock, having written nothing, then adds", async () => {
      const lock = await holdTheRosterLock();
      const adding = addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp, { rosterWaitMs: 20_000 });
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
        () => addGuardian(chen, { name: "Ana Rivera", email: "ana@example.com", samePerson: ana.id }, staffOp)];
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

    it("while a roster read holds the lock past the wait, each write answers in words having changed nothing, and holds up no code request for the person", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [row] = await rowsOf(ana.id);
      const closed = await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      await seedWorkingMail();
      const before = await counts();
      const lock = await holdTheRosterLock();
      try {
        // Through the actions, with the real wait of three seconds: the busy words.
        expect(await removeGuardianAction(row!.id, "Moved away.")).toEqual({ ok: false, errors: [BUSY] });
        expect(await reinstateGuardianAction(closed.id)).toEqual({ ok: false, errors: [BUSY] });
        expect(await addGuardianAction(String(chen), "Wen", "wen@example.com")).toEqual({ ok: false, errors: [BUSY] });
        expect(await counts()).toEqual(before);
        expect(revalidated.count).toBe(0);
        // A write waiting for the roster holds the person's row only for its wait: a code request for them, made while
        // the write waits, finishes once it gives up, with the roster still held.
        const removing = removeGuardian(row!.id, "Moved away.", staffOp, { rosterWaitMs: 1_000 });
        await untilALockIsAwaited();
        const code = requestSigninCode("ana@example.com", "203.0.113.41").then((r) => r.delivery);
        expect(await removing).toEqual({ ok: false, reason: "busy" });
        await code;
        expect((await audits("signin.code_sent")).map((r) => r.targetId)).toEqual([ana.id]);
        expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
        expect(await addGuardian(chen, { name: "Ana", email: "ana@example.com", samePerson: ana.id }, staffOp, { rosterWaitMs: 50 })).toEqual({ ok: false, reason: "busy" });
        expect(await reinstateGuardian(closed.id, staffOp, { rosterWaitMs: 50 })).toEqual({ ok: false, reason: "busy" });
        expect((await rowsOf(ana.id)).map((g) => [g.familyQboId, g.status])).toEqual([["10", "invited"], ["20", "disabled"]]);
      } finally {
        await lock.release();
      }
      // Once the read is done, the same press goes through.
      expect(await removeGuardianAction(row!.id, "Moved away.")).toMatchObject({ ok: true });
    }, 30_000);
  });

  describe("removing", () => {
    const signer = (parentId: string, name: string): RequestSigner => ({ parentId, recipientId: 1, name, email: `${name.toLowerCase()}@example.com`, signedAt: null });

    it("closes the row as removed with a note for staff only, ends that family's sessions, starts its waiting forms again, in step", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      await addKnown(chen, "Ana", "ana@example.com");
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
      expect(await audits("parent.access.ended")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: R, targetId: row!.id, ip: "203.0.113.41",
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

    it("ends the person's unused email change asked in that family; at their last open row, every unused change and code", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      await addKnown(chen, "Ana", "ana@example.com");
      const ana = (await personOf("ana@example.com"))!;
      const [inRivera, inChen] = await rowsOf(ana.id);
      const code = () => db.insert(signinCode).values({ parentId: ana.id, codeHash: "an-unused-code", expiresAt: new Date(Date.now() + 600_000) });
      const changes = async () => (await db.select().from(parentEmailChange).where(eq(parentEmailChange.parentId, ana.id))).map((c) => [c.newEmail, c.usedAt === null ? "unused" : "used"]).sort();
      const codes = async () => (await db.select().from(signinCode).where(eq(signinCode.parentId, ana.id))).length;
      // A change asked in Chen's family, and a code: removing her from Rivera's leaves both, as Chen's row is still open.
      await seedEmailChange({ parentId: ana.id, guardianId: inChen!.id, familyId: chen, recordQboId: null, newEmail: "ana.chen@example.com" });
      await code();
      await removeGuardian(inRivera!.id, "Not hers.", staffOp);
      expect(await changes()).toEqual([["ana.chen@example.com", "unused"]]);
      expect(await codes()).toBe(1);
      // Back in Rivera's, a change asked there: removing her from Rivera's again ends it, and leaves the code.
      await db.delete(parentEmailChange).where(eq(parentEmailChange.parentId, ana.id));
      await reinstateGuardian(inRivera!.id, staffOp);
      await seedEmailChange({ parentId: ana.id, guardianId: inRivera!.id, familyId: rivera, recordQboId: null, newEmail: "ana.rivera@example.com" });
      await seedEmailChange({ parentId: ana.id, guardianId: inRivera!.id, familyId: rivera, recordQboId: null, newEmail: "ana.old@example.com", usedAt: new Date() });
      await removeGuardian(inRivera!.id, "Not hers.", staffOp);
      expect(await changes()).toEqual([["ana.old@example.com", "used"]]);
      expect(await codes()).toBe(1);
      expect((await audits("parent.access.ended")).map((a) => a.after)).toContainEqual(expect.objectContaining({ familyId: String(rivera), requestsDeleted: 1 }));
      // Her last open row: an unused change asked in any family goes, and her unused code; a used one stays.
      await seedEmailChange({ parentId: ana.id, guardianId: inChen!.id, familyId: rivera, recordQboId: null, newEmail: "ana.elsewhere@example.com" });
      await removeGuardian(inChen!.id, "Moved away.", staffOp);
      expect(await changes()).toEqual([["ana.old@example.com", "used"]]);
      expect(await codes()).toBe(0);
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
      expect(await loose(addGuardianAction)(String(rivera), "New", "new@example.com", { id: ana.id })).toEqual({ ok: false, errors: [BROWSER] });
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
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: old.id, permission: R,
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

    it("refuses a row naming a customer other than its family's own, in words, changing nothing; a family with no link takes back a row that names none (slice 9d)", async () => {
      const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
      const held = await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
      const other = await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      // Her two rows swapped between the records (one row of a person per record, so through none): each now names the
      // other family's customer, not its own family's row to reopen.
      await db.update(guardian).set({ familyId: null }).where(eq(guardian.id, other.id));
      await db.update(guardian).set({ familyId: chen }).where(eq(guardian.id, held.id));
      await db.update(guardian).set({ familyId: rivera }).where(eq(guardian.id, other.id));
      const OTHER = "This sign-in was made for a different customer in QuickBooks than this family's own, so it can't be brought back here.";
      const errors = async (id: string) => ((await reinstateGuardianAction(id)) as { errors: string[] }).errors;
      expect(await errors(other.id)).toEqual([OTHER]);
      // Chen's link gone: a row naming its old customer names one the family isn't linked to.
      await db.delete(accountingLink).where(eq(accountingLink.familyId, chen));
      expect(await errors(held.id)).toEqual([OTHER]);
      expect((await rowsOf(ana.id)).every((g) => g.status === "disabled")).toBe(true);
      expect(await audits("parent.access.granted")).toEqual([]);
      // A row that names no customer, in a family with no link: taken back as it was.
      const [hand] = await db.insert(family).values({ name: "Hand Family", active: true }).returning({ id: family.id });
      const [none] = await db.insert(guardian).values({ parentId: ana.id, familyQboId: null, familyId: hand!.id, status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" }).returning();
      expect(await reinstateGuardianAction(none!.id)).toEqual({ ok: true, message: "Reinstated. Their sign-in for this family is back." });
      expect((await audits("parent.access.granted"))[0]).toMatchObject({ targetId: none!.id, after: { familyId: String(hand!.id), familyQboId: null, reinstated: true } });
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
    it("adding, removing and reinstating take Roster.Family.ReadWrite, never Parents.ReadWrite alone; a name takes Parents.ReadWrite", async () => {
      await addGuardian(rivera, { name: "Ana", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const [row] = await rowsOf(ana.id);
      // Parents.ReadWrite (with Roster.Read) alone gives nobody a family's sign-in, and ends none.
      as(parentsOnly);
      await expect(addGuardianAction(String(rivera), "Zed", "zed@example.com")).rejects.toBeInstanceOf(AccessDenied);
      await expect(addGuardianAction(String(chen), "Ana", "ana@example.com", ana.id)).rejects.toBeInstanceOf(AccessDenied);
      await expect(removeGuardianAction(row!.id, "note")).rejects.toBeInstanceOf(AccessDenied);
      await expect(reinstateGuardianAction(row!.id)).rejects.toBeInstanceOf(AccessDenied);
      expect(await renamePersonAction(ana.id, "Ana R.")).toMatchObject({ ok: true });
      expect(await personOf("zed@example.com")).toBeUndefined();
      expect((await rowsOf(ana.id)).map((g) => g.status)).toEqual(["invited"]);
      // Roster.Family.ReadWrite, with no Parents permission: each goes through, and the audit rows name it; a name doesn't.
      as(rosterWriter);
      expect(await addGuardianAction(String(chen), "Zed", "zed@example.com")).toMatchObject({ ok: true });
      expect(await removeGuardianAction(row!.id, "Moved away.")).toMatchObject({ ok: true });
      expect(await reinstateGuardianAction(row!.id)).toMatchObject({ ok: true });
      await expect(renamePersonAction(ana.id, "Zed")).rejects.toBeInstanceOf(AccessDenied);
      const byWriter = (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.actorId === rosterWriter.id && a.action.startsWith("parent."));
      expect(byWriter.map((a) => [a.action, a.permission]).sort()).toEqual([["parent.access.ended", R], ["parent.access.granted", R], ["parent.access.granted", R], ["parent.create", R]].sort());
      // Roster.Read alone: nothing.
      as(reader);
      await expect(addGuardianAction(String(rivera), "Yan", "yan@example.com")).rejects.toBeInstanceOf(AccessDenied);
      await expect(removeGuardianAction(row!.id, "note")).rejects.toBeInstanceOf(AccessDenied);
      await expect(reinstateGuardianAction(row!.id)).rejects.toBeInstanceOf(AccessDenied);
      await expect(renamePersonAction(ana.id, "Zed")).rejects.toBeInstanceOf(AccessDenied);
    });

    it("the family's box offers remove, reinstate and add to Roster.Family.ReadWrite, and links to people for Parents.ReadWrite", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      const ana = (await personOf("ana@example.com"))!;
      const sam = await seedParent({ name: "Sam Shared", email: "sam@example.com" });
      await seedGuardian({ parentId: sam.id, familyQboId: "10", status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" });
      await seedCache(ALL);
      const controls = ['Remove<span class="visually-hidden"> Ana Rivera</span>', "Reinstate Sam Shared", "Add a guardian", "Email address they sign in with"];
      const link = `href="/staff/parents/${ana.id}"`;
      const box = signinsBox(await familyPage("10"));
      for (const shown of [...controls, link, "Can&#x27;t sign in: removed by staff"]) expect(box).toContain(shown);
      const inactive = signinsBox(await familyPage("30"));
      expect(inactive).toContain("This family is inactive in the portal, so nobody can be added to it.");
      expect(inactive).not.toContain("Add guardian<");
      as(rosterWriter);
      const writer = signinsBox(await familyPage("10"));
      for (const shown of controls) expect(writer).toContain(shown);
      expect(writer).not.toContain("/staff/parents/");
      as(parentsOnly);
      const parents = signinsBox(await familyPage("10"));
      expect(parents).toContain(link);
      for (const gone of ["Remove", "Reinstate", "Add a guardian"]) expect(parents).not.toContain(gone);
      as(reader);
      const plain = signinsBox(await familyPage("10"));
      expect(plain).toContain("Ana Rivera");
      for (const gone of ["Remove", "Reinstate", "Add a guardian", "/staff/parents/"]) expect(plain).not.toContain(gone);
    });

    it("the person's page offers remove and reinstate only beside Roster.Family.ReadWrite, and the name form to Parents.ReadWrite", async () => {
      await addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com" }, staffOp);
      await addKnown(chen, "Ana Rivera", "ana@example.com");
      const ana = (await personOf("ana@example.com"))!;
      const [, inChen] = await rowsOf(ana.id);
      await removeGuardian(inChen!.id, "Not hers.", staffOp);
      const html = await personPage(ana.id);
      expect(familiesBox(html)).toContain('Remove<span class="visually-hidden"> Rivera Family</span>');
      expect(familiesBox(html)).toContain("Reinstate Chen Family");
      expect(html).toContain('id="pn-h">Name</h2>');
      expect(html).toContain('value="Ana Rivera"');
      as(parentsOnly);
      const theirs = await personPage(ana.id);
      expect(familiesBox(theirs)).toContain("Rivera Family");
      for (const gone of ["Remove", "Reinstate"]) expect(familiesBox(theirs)).not.toContain(gone);
      expect(theirs).toContain('id="pn-h">Name</h2>');
      expect(theirs).toContain('value="Ana Rivera"');
    });
  });
});
