import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
// Mail goes to an outbox: nothing here should send any.
type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, parent, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, QUEUE_IN_THE_WAY, type InactiveRow, type LinkRow, type LinksView, type TakeOffer } from "@/lib/accounting/mapping";
import { takeStamp } from "@/lib/accounting/stamp";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { refreshRoster } from "@/lib/roster/refresh";
import { FAMILY_BEING_CHANGED, heldWords, KEPT_OFF_STAYS, MOVE_PENDING, SENDING_LOCK, STUDENT_BEING_CHANGED, TAKE_CHANGED, takeFromBooks, WRITE_COPY } from "@/lib/roster/writes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { releaseSigninHold, signinHeldOfGuardian } from "@/lib/parents/guardians";
import { addGuardianAction, releaseSigninHoldAction } from "@/app/staff/(app)/parents/actions";
import { takeDifferenceAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { resetDb, seedGuardian, seedGuardianInFamily, seedParent, seedWorkingMail } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { auditsOf, connectRoster, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Take the books' value, making a record active again (stage 4's slice M4b of the app-owned families spec;
 * section 5, "Differences"; open question 12: the only way a record becomes active again; takeFromBooks() with `active`
 * in src/lib/roster/writes.ts): an inactive student record of an active family whose customer the books have active
 * under the family's, on the family's row, and an inactive linked family the books have active, in the screen's own
 * list after the families. Nothing is sent to QuickBooks. Nobody is let in by it: the family's sign-ins are held until
 * someone who may change families releases them on its page (releaseSigninHold(), the lead's decision 2 on the owner's
 * choice 5, which the owner confirmed on 2026-11-21). The company is fznCompany()'s (tests/helpers/qbo-stub.ts): Rivera
 * Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student), Chen Family 20 with Mei Chen 21 (Parent). A record
 * is made inactive in the portal only by the portal's own take of the books' inactive (press of M4a), and the books
 * change only through a roster read of the stub (readAgain(), changeInBooks()); customers added before any record is
 * changed in the portal are imported (syncAppRecords()), never after.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };
/** Holds one of the advisory locks a send holds, for as long as `run` takes, on another connection. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const offerOf = async (name: string, field: TakeOffer["field"]): Promise<TakeOffer> => {
  const t = rowOf(await loadAccountingLinks(), name).takes.find((x) => x.field === field);
  if (!t) throw new Error(`the row ${name} offers no take of ${field}`);
  return t;
};
const inactiveOf = async (name: string): Promise<InactiveRow> => {
  const r = (await loadAccountingLinks()).inactive.find((x) => x.name === name);
  if (!r) throw new Error(`no inactive row named ${name}`);
  return r;
};
const pressWith = (field: TakeOffer["field"], kind: "family" | "student", recordId: string, stamp: string, t = tag) =>
  takeFromBooks(field === "place" ? { field, studentId: recordId, stamp } : { field, kind, recordId, stamp }, t, linkOp());
const press = (o: TakeOffer) => pressWith(o.field, o.kind, o.recordId, o.stamp);
/** The take rows of making a record active again, newest first. */
const activeTakes = async () => (await auditsOf("accounting.difference.take")).filter((a) => (a.after as { field?: string } | null)?.field === "active");
const familyRow = async (id: AppFamilyId) => (await db.select().from(family).where(eq(family.id, id)))[0]!;
const studentRow = async (id: AppStudentId) => (await db.select().from(student).where(eq(student.id, id)))[0]!;
const guardianRows = () => db.select().from(guardian).orderBy(guardian.id);
/** Every request made to the books since the calls were last cleared, but the roster's own reads: what a press could have sent. */
const sentSince = () => stub.apiCalls().filter((c) => c.method !== "GET");
const holderOp = (who: { id: string; email: string }) => ({ actor: { door: "staff" as const, id: who.id, label: who.email }, ip: "203.0.113.9", permission: "Roster.Family.ReadWrite" });
const HELD = (name: string) => heldWords(name);
const FAMILY_FIRST = "This student's family is inactive in the portal, so they weren't made active: a family comes first. Take its active status from the books on its own row, then this student's.";

let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId;
let ana: Awaited<ReturnType<typeof seedAnaRivera>>["ana"];
beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
});
/** The layered company, Ana Rivera's guardian row in the Rivera family. */
async function layered() {
  tag = await connectRoster(stub);
  ({ ana } = await seedAnaRivera());
  [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
}
/** Leo inactive in the portal by the portal's own take of the books' inactive, then active in the books again by a read. */
async function leoInactiveHere() {
  changeInBooks("12", { Active: false });
  await readAgain();
  expect(await press(await offerOf("Rivera Family", "inactive"))).toMatchObject({ ok: true });
  changeInBooks("12", { Active: true });
  await readAgain();
  expect(await studentRow(leo)).toMatchObject({ active: false, familyId: rivera });
}
/** The Rivera family inactive in the portal, with Leo, by the portal's own take, then both active in the books again by a read. */
async function riveraInactiveHere() {
  changeInBooks("10", { Active: false });
  changeInBooks("12", { Active: false });
  await readAgain();
  const t = rowOf(await loadAccountingLinks(), "Rivera Family").takes.find((x) => x.field === "inactive" && x.kind === "family")!;
  expect(await press(t)).toMatchObject({ ok: true });
  changeInBooks("10", { Active: true });
  changeInBooks("12", { Active: true });
  await readAgain();
  expect(await familyRow(rivera)).toMatchObject({ active: false });
  expect(await studentRow(leo)).toMatchObject({ active: false });
}

describe("a student made active again", () => {
  beforeEach(layered);

  it("with the students rule off: made active, nothing sent, one row, no hold, and the difference gone", async () => {
    await leoInactiveHere();
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    const offer = await offerOf("Rivera Family", "active");
    expect(offer).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's active status",
      words: ["Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books." });
    expect(stub.apiCalls()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: true, familyId: rivera });
    expect(await familyRow(rivera)).toMatchObject({ active: true, signinHeldAt: null, signinHeldBy: null });
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    const [row, ...more] = await activeTakes();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ targetType: "student", targetId: String(leo), permission: "Accounting.Link.ReadWrite", before: { active: false },
      after: { field: "active", kind: "student", familyId: String(rivera), studentId: String(leo), customerQboId: "12", active: true, held: false } });
    // The audit page's record filter finds it by its target.
    expect((await auditPage(parseAuditFilters({ record: `student:${leo}` }), {}, 500)).rows.map((r) => r.id)).toContain(row!.id);
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").differences).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(mail.outbox).toEqual([]);
  });

  it("with the students rule in force and the family's last student: the family held, its guardian kept out until the release, then counted", async () => {
    await seedParentSettings({ requireActiveStudents: true });
    await leoInactiveHere();
    // No active student: Ana can't sign in to Rivera, and a take that brings Leo back would let her in, so it holds.
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    const offer = await offerOf("Rivera Family", "active");
    expect(offer.words).toEqual(["Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books.", HELD("Rivera Family")]);
    expect(HELD("Rivera Family")).toBe("Rivera Family's guardians can't sign in to it until someone who may change families lets them in, on its page.");
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: `Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books. ${HELD("Rivera Family")}` });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: true });
    const held = await familyRow(rivera);
    expect(held.signinHeldAt).not.toBeNull();
    expect(held.signinHeldBy).toBe(linker.id);
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect((await activeTakes())[0]!.after).toMatchObject({ field: "active", kind: "student", studentId: String(leo), held: true });
    // The release, by someone who may change families: counted at once.
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    expect(await releaseSigninHold(rivera, holderOp(holder))).toEqual({ ok: true, name: "Rivera Family", counting: 1, signingIn: 1 });
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    expect(await familyRow(rivera)).toMatchObject({ signinHeldAt: null, signinHeldBy: null });
    const [released, ...again] = await auditsOf("roster.family.signin_released");
    expect(again).toEqual([]);
    expect(released).toMatchObject({ targetType: "family", targetId: String(rivera), permission: "Roster.Family.ReadWrite",
      before: { heldAt: held.signinHeldAt!.toISOString(), heldBy: linker.id }, after: { counting: 1 } });
    expect((await auditPage(parseAuditFilters({ record: `family:${rivera}` }), {}, 500)).rows.map((r) => r.id)).toContain(released!.id);
  });

  it("through the press itself (takeDifferenceAction()), with field active: taken, and the pages shown again", async () => {
    await leoInactiveHere();
    const offer = await offerOf("Rivera Family", "active");
    asStaff(linker);
    expect(await takeDifferenceAction("active", "student", offer.recordId, tag, offer.stamp))
      .toEqual({ ok: true, message: "Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books." });
    expect(revalidatedPaths()).toContain("/");
    expect(await studentRow(leo)).toMatchObject({ active: true });
    expect(await activeTakes()).toHaveLength(1);
  });

  it("with the students rule in force and another active student in the family: no hold, and its words don't say one", async () => {
    // Mia Rivera (13), imported before anything is changed in the portal.
    await readAgain(qc("13", "Mia Rivera", "3", under("10")));
    await syncAppRecords();
    await seedParentSettings({ requireActiveStudents: true });
    await leoInactiveHere();
    // Mia is active: Ana signs in to Rivera already, so bringing Leo back opens nothing.
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    const offer = await offerOf("Rivera Family", "active");
    expect(offer.words).toEqual(["Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books."]);
    expect(await press(offer)).toEqual({ ok: true, message: "Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books." });
    expect(await familyRow(rivera)).toMatchObject({ signinHeldAt: null, signinHeldBy: null });
    expect((await activeTakes())[0]!.after).toMatchObject({ kind: "student", held: false });
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
  });

  it("with a make-inactive of the customer kept on Reconciliation: taken, and the kept change stays as it is, said", async () => {
    await leoInactiveHere();
    const kept = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code: "fault_6220" });
    const offer = await offerOf("Rivera Family", "active");
    expect(offer.words).toEqual(["Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books.", KEPT_OFF_STAYS]);
    expect(await press(offer)).toEqual({ ok: true, message: `Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books. ${KEPT_OFF_STAYS}` });
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, kept.id)))[0]).toMatchObject({ state: "refused" });
    expect(await auditsOf("roster.write.replaced")).toEqual([]);
  });
});

describe("a family made active again", () => {
  beforeEach(layered);

  it("listed after the families, made active alone, held, its guardian kept out before and after the take and counted after the release", async () => {
    await riveraInactiveHere();
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    const guardiansBefore = await guardianRows();
    const view = await loadAccountingLinks();
    // Not a row of the list: no status, filter or count includes it.
    expect(view.rows.map((r) => r.name)).not.toContain("Rivera Family");
    const listed = await inactiveOf("Rivera Family");
    expect(listed).toMatchObject({ familyId: rivera, customer: "Rivera Family", students: ["Leo Rivera"], note: null,
      take: { field: "active", kind: "family", recordId: String(rivera), about: "Rivera Family's active status",
        words: ["Makes Rivera Family active in the portal, as the books have it alone: its students stay inactive in the portal, and each the books have active shows on its row once it is listed, with a press of its own. Nothing is sent to the books.",
          HELD("Rivera Family")] } });
    stub.calls.length = 0;
    expect(await press(listed.take!)).toEqual({ ok: true, message: "Made Rivera Family active in the portal, as the books have it. Nothing was sent to the books. "
      + `Its students stay inactive in the portal: each the books have active shows on the family's row, with a press of its own. ${HELD("Rivera Family")}` });
    expect(stub.apiCalls()).toEqual([]);
    const f = await familyRow(rivera);
    expect(f).toMatchObject({ active: true, signinHeldBy: linker.id });
    expect(f.signinHeldAt).not.toBeNull();
    expect(await studentRow(leo)).toMatchObject({ active: false });
    // Held: still out, and no guardian row was opened, closed or changed.
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect(await guardianRows()).toEqual(guardiansBefore);
    const [row, ...more] = await activeTakes();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ targetType: "family", targetId: String(rivera), before: { active: false },
      after: { field: "active", kind: "family", familyId: String(rivera), customerQboId: "10", active: true, held: true } });
    // Listed again among the families, with Leo's own press, which says the hold that stands; the inactive list is empty.
    const after = await loadAccountingLinks();
    expect(after.inactive).toEqual([]);
    const leos = rowOf(after, "Rivera Family").takes.find((t) => t.field === "active")!;
    expect(leos).toMatchObject({ kind: "student", recordId: String(leo), words: ["Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books.", HELD("Rivera Family")] });
    // Leo's take keeps the family's first hold, and sets none of its own.
    expect(await press(leos)).toEqual({ ok: true, message: `Made Leo Rivera active in the portal, as the books have them. Nothing was sent to the books. ${HELD("Rivera Family")}` });
    expect((await familyRow(rivera)).signinHeldAt).toEqual(f.signinHeldAt);
    expect((await activeTakes())[0]!.after).toMatchObject({ kind: "student", held: false });
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    expect(await releaseSigninHold(rivera, holderOp(holder))).toEqual({ ok: true, name: "Rivera Family", counting: 1, signingIn: 1 });
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    expect(await guardianRows()).toEqual(guardiansBefore);
    expect(sentSince()).toEqual([]);
  });
});

describe("a member made active again, in flat books", () => {
  it("made active, held, its guardian counted only after the release", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    [rivera, chen] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family")];
    // A guardian of the member's record, written here (no import after it).
    const pat = await seedParent({ name: "Pat Rivera", email: "pat@example.com" });
    const g = await seedGuardian({ parentId: pat.id, familyQboId: "10" });
    await db.update(guardian).set({ familyId: rivera }).where(eq(guardian.id, g.id));
    changeInBooks("10", { Active: false });
    await readAgain();
    expect(await press(await offerOf("Rivera Family", "inactive"))).toMatchObject({ ok: true });
    changeInBooks("10", { Active: true });
    await readAgain();
    expect(await enterableGuardianRows(pat.id)).toEqual([]);
    const listed = await inactiveOf("Rivera Family");
    expect(listed).toMatchObject({ customer: "Rivera Family", students: [], note: null,
      take: { words: ["Makes Rivera Family active in the portal, as the books have it. Nothing is sent to the books.", HELD("Rivera Family")] } });
    stub.calls.length = 0;
    expect(await press(listed.take!)).toEqual({ ok: true, message: `Made Rivera Family active in the portal, as the books have it. Nothing was sent to the books. ${HELD("Rivera Family")}` });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: true, signinHeldBy: linker.id });
    expect(await enterableGuardianRows(pat.id)).toEqual([]);
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    expect(await releaseSigninHold(rivera, holderOp(holder))).toEqual({ ok: true, name: "Rivera Family", counting: 1, signingIn: 1 });
    expect((await enterableGuardianRows(pat.id)).map((r) => r.id)).toEqual([g.id]);
  });
});

describe("refused, changing nothing", () => {
  beforeEach(layered);

  it("a student: a stale stamp, a change waiting for the customer, a move kept, the lock held, and a student of an inactive family", async () => {
    await leoInactiveHere();
    const drawn = await offerOf("Rivera Family", "active");
    stub.calls.length = 0;
    // The books made Leo inactive again by a read after the page was drawn.
    changeInBooks("12", { Active: false });
    await readAgain();
    expect(await press(drawn)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    changeInBooks("12", { Active: true });
    await readAgain();
    // The students rule switched on after the page was drawn: the take would now hold the family, which the row didn't say.
    await seedParentSettings({ requireActiveStudents: true });
    expect(await press(drawn)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    await seedParentSettings({ requireActiveStudents: false });
    // A rename of Leo's customer waiting: no press, the queue's sentence, and the one drawn refused.
    const waiting = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo Rivera" }, { state: "waiting" });
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes).toEqual([]);
    expect(row.takeNotes).toEqual([{ at: row.differences.findIndex((d) => d.kind === "active"), words: QUEUE_IN_THE_WAY }]);
    expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    // A move of Leo the books refused, kept on Reconciliation.
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes).toEqual([]);
    expect(await press(drawn)).toEqual({ ok: false, errors: [expect.stringContaining("A move of this student hasn't reached QuickBooks yet")] });
    expect((await press(drawn) as { errors: string[] }).errors[0]).toContain("so they weren't made active");
    await db.delete(writeQueue).where(eq(writeQueue.id, kept.id));
    // The lock held: a change of the student under way.
    expect(await holding(SENDING_LOCK, String(leo), () => press(drawn))).toEqual({ ok: false, errors: [STUDENT_BEING_CHANGED] });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect(await activeTakes()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ signinHeldAt: null });
  });

  it("an inactive family with no link isn't listed, and offers nothing", async () => {
    await riveraInactiveHere();
    expect((await loadAccountingLinks()).inactive.map((r) => r.name)).toEqual(["Rivera Family"]);
    // Its link ended (the test's own write: nothing reads it before the screen).
    await db.delete(accountingLink).where(eq(accountingLink.familyId, rivera));
    expect((await loadAccountingLinks()).inactive).toEqual([]);
  });

  it("a student of an inactive family isn't offered, and a press called anyway is refused: the family comes first", async () => {
    await riveraInactiveHere();
    expect((await loadAccountingLinks()).rows.flatMap((r) => r.takes).filter((t) => t.recordId === String(leo))).toEqual([]);
    stub.calls.length = 0;
    expect(await pressWith("active", "student", String(leo), takeStamp("active", String(leo), "12", [false]))).toEqual({ ok: false, errors: [FAMILY_FIRST] });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect(await familyRow(rivera)).toMatchObject({ active: false, signinHeldAt: null });
    expect(await activeTakes()).toEqual([]);
  });

  it("a family: a stale stamp, its name now held by another active family, a change waiting, a move pending, the lock held", async () => {
    await riveraInactiveHere();
    const drawn = (await inactiveOf("Rivera Family")).take!;
    stub.calls.length = 0;
    // The books made the customer inactive again by a read: no longer listed, and the press drawn refused.
    changeInBooks("10", { Active: false });
    await readAgain();
    expect((await loadAccountingLinks()).inactive).toEqual([]);
    expect(await press(drawn)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    changeInBooks("10", { Active: true });
    await readAgain();
    // Its name now another active family's (the test's own write: nothing else reads it before the press).
    await db.update(family).set({ name: "Rivera Family" }).where(eq(family.id, chen));
    expect(await inactiveOf("Rivera Family")).toMatchObject({ take: null,
      note: "Another family in the portal is called “Rivera Family”, and every family's name must be different, so Rivera Family can't be made active until one of them is renamed on its page." });
    expect(await press(drawn)).toEqual({ ok: false,
      errors: ["Another family in the portal is called “Rivera Family”, and every family's name must be different, so Rivera Family wasn't made active. Rename one of them on its page first."] });
    await db.update(family).set({ name: "Chen Family" }).where(eq(family.id, chen));
    // The record renamed since the page was drawn (the test's own write): the stamp sealed its name.
    await db.update(family).set({ name: "Rivera Household" }).where(eq(family.id, rivera));
    expect(await press(drawn)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    await db.update(family).set({ name: "Rivera Family" }).where(eq(family.id, rivera));
    // A rename of its customer waiting: the queue's sentence in place of the press, and the one drawn refused.
    const waiting = await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Household", was: "Rivera Family" }, { state: "waiting" });
    expect(await inactiveOf("Rivera Family")).toMatchObject({ take: null, note: QUEUE_IN_THE_WAY });
    expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    // A move out of it kept on Reconciliation.
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    expect(await inactiveOf("Rivera Family")).toMatchObject({ take: null, note: QUEUE_IN_THE_WAY });
    expect(await press(drawn)).toEqual({ ok: false, errors: [MOVE_PENDING] });
    await db.delete(writeQueue).where(eq(writeQueue.id, kept.id));
    // The lock held: a change of the family under way.
    expect(await holding(SENDING_LOCK, String(rivera), () => press(drawn))).toEqual({ ok: false, errors: [FAMILY_BEING_CHANGED] });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: false, signinHeldAt: null, name: "Rivera Family" });
    expect(await activeTakes()).toEqual([]);
    // Nothing in the way any more: the press drawn first goes through.
    expect(await press(drawn)).toMatchObject({ ok: true });
  });
});

describe("the release", () => {
  beforeEach(layered);

  it("only for Roster.Family.ReadWrite, only for a family with a hold, one audit row, and the page shown again", async () => {
    await riveraInactiveHere();
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    // The linker holds the linking permission and Roster.Read, not Roster.Family.ReadWrite: refused as the guard refuses.
    asStaff(linker);
    await expect(releaseSigninHoldAction(String(rivera))).rejects.toBeInstanceOf(AccessDenied);
    expect(await familyRow(rivera)).toMatchObject({ signinHeldBy: linker.id });
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(holder);
    for (const bad of ["not-a-uuid", "00000000-0000-4000-8000-000000000000", 7]) {
      expect(await (releaseSigninHoldAction as unknown as (...a: unknown[]) => Promise<unknown>)(bad)).toEqual({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
    }
    expect(await auditsOf("roster.family.signin_released")).toEqual([]);
    expect(await releaseSigninHoldAction(String(rivera))).toEqual({ ok: true, message: "Done. Its 1 open guardian can sign in to Rivera Family now, while parent sign-ins are on." });
    expect(revalidatedPaths()).toContain("/staff");
    expect(await auditsOf("roster.family.signin_released")).toHaveLength(1);
    // A family with no hold: refused, nothing changed, no row.
    expect(await releaseSigninHoldAction(String(rivera))).toEqual({ ok: false, errors: ["This family's guardians aren't held back from signing in, so nothing was changed. Reload the page."] });
    expect(await releaseSigninHoldAction(String(chen))).toEqual({ ok: false, errors: ["This family's guardians aren't held back from signing in, so nothing was changed. Reload the page."] });
    expect(await auditsOf("roster.family.signin_released")).toHaveLength(1);
  });
});

describe("the release's words and a held family's guardians", () => {
  beforeEach(layered);

  it("count only the guardians who can sign in: a blocked person's open row counts by the gate's rule in the audit row, not in the words", async () => {
    await riveraInactiveHere();
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    // Ben Rivera, a second open guardian of the family, and Ana blocked (the test's own writes, after every take).
    const ben = await seedParent({ name: "Ben Rivera", email: "ben@example.com" });
    await seedGuardianInFamily({ parentId: ben.id, familyQboId: "10" });
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(holder);
    const page = (await renderPage(RosterEntryPage, { params: { id: String(rivera) } })).replaceAll("&#x27;", "'");
    expect(page).toContain("at once, while parent sign-ins are on: 1 guardian, Ben Rivera.");
    expect(await releaseSigninHoldAction(String(rivera))).toEqual({ ok: true, message: "Done. Its 1 open guardian can sign in to Rivera Family now, while parent sign-ins are on." });
    const [released] = await auditsOf("roster.family.signin_released");
    expect(released).toMatchObject({ targetId: String(rivera), after: { counting: 2 } });
  });

  it("say nobody can sign in when the only open guardian is blocked", async () => {
    await riveraInactiveHere();
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(holder);
    expect(await releaseSigninHoldAction(String(rivera))).toEqual({ ok: true, message: "Done. Nobody can sign in to Rivera Family yet all the same: it has no open guardian who isn't blocked, or none the portal lets in now (the family may be inactive, or have no active student while the club asks for one)." });
    expect((await auditsOf("roster.family.signin_released"))[0]).toMatchObject({ after: { counting: 1 } });
  });

  it("an add to a held family says its sign-ins are held all the same, and a guardian row's hold is read by its family", async () => {
    await riveraInactiveHere();
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    const anas = (await guardianRows()).find((g) => g.parentId === ana.id)!;
    expect(await signinHeldOfGuardian(anas.id)).toBe(true);
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(holder);
    const added = await addGuardianAction(String(rivera), "Ben Rivera", "ben@example.com");
    expect(added).toMatchObject({ ok: true });
    expect((added as { message: string }).message).toContain("This family's sign-ins are held all the same, so they can't sign in to it until someone who may change families lets its guardians in, under Sign-ins held on this page.");
    expect(await releaseSigninHoldAction(String(rivera))).toMatchObject({ ok: true });
    expect(await signinHeldOfGuardian(anas.id)).toBe(false);
  });
});

describe("the pages", () => {
  beforeEach(layered);
  /** One section of a page, from its heading to the end of its section, read as drawn text. */
  const sectionOf = (html: string, id: string) => {
    const at = html.indexOf(`id="${id}"`);
    return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at)).replaceAll("&#x27;", "'");
  };
  const pressesIn = (part: string) => [...part.matchAll(/Take the books' value<span class="visually-hidden">: ([^<]*)<\/span>/g)].map((m) => m[1]).sort();

  it("Accounting links: the inactive list with its press and words, none for a customer inactive in the books or not held, and a student's press on its row", async () => {
    // Oak Family (80) imported before anything is changed in the portal.
    await readAgain(qc("80", "Oak Family", "1"));
    await syncAppRecords();
    // Chen made inactive here by its take, and left inactive in the books.
    changeInBooks("20", { Active: false });
    await readAgain();
    expect(await press(rowOf(await loadAccountingLinks(), "Chen Family").takes.find((t) => t.field === "inactive")!)).toMatchObject({ ok: true });
    // Oak made inactive here by its take, then gone from the books.
    changeInBooks("80", { Active: false });
    await readAgain();
    expect(await press(rowOf(await loadAccountingLinks(), "Oak Family").takes.find((t) => t.field === "inactive")!)).toMatchObject({ ok: true });
    stub.customers = stub.customers.filter((c) => c.Id !== "80");
    await readAgain();
    asStaff(linker);
    // Nothing listed yet: the section isn't drawn.
    expect(sectionOf(await renderPage(AccountingLinksPage), "links-inactive-h")).toBe("");
    await riveraInactiveHere();
    const whole = await renderPage(AccountingLinksPage);
    const part = sectionOf(whole, "links-inactive-h");
    expect(part).toContain("Inactive here, active in your books (1)");
    expect(pressesIn(part)).toEqual(["Rivera Family's active status"]);
    expect(part).toContain("Makes Rivera Family active in the portal, as the books have it alone: its students stay inactive in the portal");
    expect(part).toContain(HELD("Rivera Family"));
    expect(part).toContain("Leo Rivera");
    expect(part).not.toMatch(/Chen Family|Oak Family/);
    // The families' own list doesn't count it, and draws no press for it.
    expect(sectionOf(whole, "links-list-h")).not.toContain("Rivera Family's active status");
    expect(whole).toContain("Taking the books&#x27; value makes the family active here again and sends nothing.");
    // Since the redesign of 2026-11-27 the lede says linking sends nothing; each Send says what it sends beside itself.
    expect(whole).toContain("Linking sends nothing to the books.");
    // Taken: Rivera is a row again, and Leo's press is on it.
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    const again = await renderPage(AccountingLinksPage);
    expect(sectionOf(again, "links-inactive-h")).toBe("");
    const list = sectionOf(again, "links-list-h");
    expect(pressesIn(list)).toContain("Leo Rivera's active status");
    expect(list).toContain(`Makes Leo Rivera active in the portal, as the books have them. Nothing is sent to the books. ${HELD("Rivera Family")}`);
  });

  it("the family's page: the hold's Notice and button for someone who may change families, the Notice alone for Roster.Read", async () => {
    await riveraInactiveHere();
    expect(await press((await inactiveOf("Rivera Family")).take!)).toMatchObject({ ok: true });
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    const reader = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(holder);
    const forHolder = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }), "entry-hold-h");
    expect(forHolder).toContain("Sign-ins held");
    expect(forHolder).toContain("Rivera Family's guardians can't sign in to it now. It was made active again from the books on the accounting links screen (the family, or one of its students), by linker, on ");
    expect(forHolder).toContain("Once let in, they count at once: the family is active and nothing else keeps them out.");
    expect(forHolder).toContain("Let its guardians sign in ends the hold. Every open guardian of it can then sign in to it at once, while parent sign-ins are on: 1 guardian, Ana Rivera.");
    expect(forHolder).toContain(">Let its guardians sign in</button>");
    // The staff member's id is never drawn: their name is.
    expect(forHolder).not.toContain(linker.id);
    asStaff(reader);
    const forReader = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }), "entry-hold-h");
    expect(forReader).toContain("Rivera Family's guardians can't sign in to it now.");
    expect(forReader).not.toContain("Let its guardians sign in");
    // The guardians' table says why Ana can't sign in now.
    const signins = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }), "entry-signins-h");
    expect(signins).toContain("Can't sign in now: the family was made active again from the books, and its guardians wait for someone who may change families to let them in on its page");
    // Released: no Notice.
    expect(await releaseSigninHold(rivera, holderOp(holder))).toMatchObject({ ok: true });
    expect(sectionOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }), "entry-hold-h")).toBe("");
  });

  it("the family's page: while something else keeps them out, the button's words don't say at once", async () => {
    await seedParentSettings({ requireActiveStudents: true });
    await leoInactiveHere();
    expect(await press(await offerOf("Rivera Family", "active"))).toMatchObject({ ok: true });
    // Leo inactive in the books again, and taken so: the family is held and has no active student.
    changeInBooks("12", { Active: false });
    await readAgain();
    expect(await press(await offerOf("Rivera Family", "inactive"))).toMatchObject({ ok: true });
    const holder = await staffWith("holder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(holder);
    const part = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }), "entry-hold-h");
    expect(part).toContain("Even once let in, they can't sign in yet: the family has no active student, and the club asks for one.");
    expect(part).toContain("Every open guardian of it can then sign in to it once what keeps them out above no longer stands: 1 guardian, Ana Rivera.");
    expect(part).not.toContain("at once");
  });
});
