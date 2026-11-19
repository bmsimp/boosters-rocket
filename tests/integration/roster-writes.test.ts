import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, qboConnection, qboCustomer, setting, writeQueue } from "@/lib/db/schema";
import { askFamilyInactive, askRosterWrite, familyCover, familyHereWords, REFRESH_ASK_KEY, WRITE_COPY } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { NOT_HERE } from "@/lib/roster/operations";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { setRosterSource } from "@/lib/roster/source";
import { formWithdrawal, signedFormEvidence, signedFormFile, volunteerSignup } from "@/lib/db/schema";
import { resetDb, seedParent, untilALockIsAwaited } from "../helpers/db";
import { formSetting, requestByCustomer, seedEvidence, seedFormRequirement, seedRequest } from "../helpers/forms";
import { recordOfCustomer } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { holdTheRosterLock } from "../helpers/reconcile";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const sent = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const queue = () => db.select().from(writeQueue);
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));

let tag: string;
let op: ReturnType<typeof asOp>;
beforeEach(async () => {
  await resetDb(); stub.reset();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
});

/** The list a family's page shows and binds into its form: every id it covers, the family's too, with its version. */
const shownFor = async (familyQboId: string): Promise<[string, string][]> => {
  const c = (await familyCover(familyQboId))!;
  return [[c.family.qboId, c.family.syncToken], ...c.under.map((u): [string, string] => [u.qboId, u.syncToken])];
};
/** An open invoice on a customer, for what it owes. */
const owes = (Id: string, customer: string, amount: number) => ({ Id, SyncToken: "0", CustomerRef: { value: customer }, TotalAmt: amount, Balance: amount });

describe("staff change the roster in QuickBooks, and the cache follows QuickBooks' answer (v1 spec §6.1)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("makes a family: a customer of the family type, and nothing else, then the family is on the roster", async () => {
    const r = await askRosterWrite({ op: "create", role: "family", name: " Okafor  Family ", familyQboId: null, email: null, typeQboId: null }, tag, op);
    expect(r).toEqual({ ok: true, message: expect.stringContaining("QuickBooks has it") });
    expect(sent()).toEqual([{ DisplayName: "Okafor Family", CustomerTypeRef: { value: "1" } }]);
    const made = stub.customers.find((c) => c.DisplayName === "Okafor Family")!;
    expect(await cached(made.Id as string)).toMatchObject({ displayName: "Okafor Family", typeQboId: "1", parentQboId: null, active: true, syncToken: "0" });
    const [row] = await auditsOf("roster.customer.create");
    expect(row).toMatchObject({ door: "staff", actorLabel: "registrar@club.org", permission: "Roster.Family.ReadWrite", targetType: "qbo_customer", targetId: made.Id, ip: "203.0.113.9",
      before: null, after: { role: "family", name: "Okafor Family", active: true, familyQboId: null, syncToken: "0" } });
  });

  it("adds a student under a family: ParentRef, Job and BillWithParent, with the student type", async () => {
    const r = await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: "2" }, tag, op);
    expect(r.ok).toBe(true);
    // The type is the shape's, whatever the page sent.
    expect(sent()).toEqual([{ DisplayName: "Rosa Rivera", CustomerTypeRef: { value: "3" }, ParentRef: { value: "10" }, Job: true, BillWithParent: true }]);
    const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
    expect(await cached(made.Id as string)).toMatchObject({ parentQboId: "10", typeQboId: "3", email: null });
  });

  it("adds a parent with their own email address, billed apart; the portal makes them no sign-in from it", async () => {
    await seedParentSettings(SIGNINS_ON);
    const r = await askRosterWrite({ op: "create", role: "parent", name: "Luis Rivera", familyQboId: "10", email: " Luis@Example.COM ", typeQboId: null }, tag, op);
    expect(r.ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Luis Rivera", CustomerTypeRef: { value: "2" }, ParentRef: { value: "10" }, Job: true, BillWithParent: false,
      PrimaryEmailAddr: { Address: "luis@example.com" } }]);
    const made = stub.customers.find((c) => c.DisplayName === "Luis Rivera")!;
    expect(await cached(made.Id as string)).toMatchObject({ email: "luis@example.com", typeQboId: "2" });
    // Who signs in is the portal's own list of guardians (stage 3 of the app-owned families spec): a parent added in
    // QuickBooks is given none, whatever the switches say.
    expect(await db.select().from(parent).where(eq(parent.email, "luis@example.com"))).toEqual([]);
    expect(await db.select().from(guardian)).toEqual([]);
  });

  it("refuses a parent with no usable address, before anything is sent", async () => {
    for (const email of [null, "", "not an address"]) {
      const r = await askRosterWrite({ op: "create", role: "parent", name: "Luis Rivera", familyQboId: "10", email, typeQboId: null }, tag, op);
      expect(r).toEqual({ ok: false, errors: [expect.stringContaining("own email address")] });
    }
    expect(posts()).toEqual([]);
  });

  it("renames with the version the page was shown, sending the name alone", async () => {
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: true, message: "Renamed in QuickBooks." });
    expect(sent()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(inStub("12")).toMatchObject({ DisplayName: "Leon Rivera", ParentRef: { value: "10" }, CustomerTypeRef: { value: "3" }, Active: true });
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera", syncToken: "1", parentQboId: "10" });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ before: { name: "Leo Rivera", syncToken: "0" }, after: { name: "Leon Rivera", syncToken: "1" } });
  });

  it("moves a student to another family, and records the move for what follows the student", async () => {
    const r = await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op);
    expect(r).toEqual({ ok: true, message: "Moved in QuickBooks." });
    expect(sent()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, ParentRef: { value: "20" }, Job: true, BillWithParent: true }]);
    expect(await cached("12")).toMatchObject({ parentQboId: "20", syncToken: "1" });
    expect((await auditsOf("roster.student.move"))[0]).toMatchObject({ before: { familyQboId: "10" }, after: { familyQboId: "20" } });
    expect((await auditsOf("roster.student.move.followed"))[0]).toMatchObject({ targetId: "12", after: { fromFamilyQboId: "10", toFamilyQboId: "20" } });
  });

  it("moves a student with an open form, a signed form and a place on a shift to come: the forms and the place follow the move", async () => {
    const season = await seedSeason({ name: "Moving season", steps: [{ name: "Join" }] });
    const stepId = season.stepIds["Join"]!;
    const openReq = await seedFormRequirement({ stepId, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
    const signedReq = await seedFormRequirement({ stepId, title: "Photo consent", appliesTo: "student", form: formSetting({ id: "envelope_tmplphoto" }), position: 60 });
    const open = await seedRequest({ requirementId: openReq, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_movedopen1" });
    const signed = await seedRequest({ requirementId: signedReq, familyQboId: "10", subjectQboId: "12", state: "complete", envelopeId: "envelope_movedsigned" });
    const evidence = await seedEvidence(signed, { tag: "moved" });
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const { shifts: [shift] } = await seedEvent({ inDays: 20 });
    const place = await seedSignup({ shiftId: shift!.id, familyQboId: "10", signedUpBy: ana.id, student: { qboId: "12", name: "Leo Rivera" } });

    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toEqual({ ok: true, message: "Moved in QuickBooks." });

    // The open form starts again under the new family, and its document waits for the worker to withdraw it.
    expect(await requestByCustomer(open)).toMatchObject({ familyQboId: "20", state: "not_opened", envelopeId: null });
    expect(await db.select().from(formWithdrawal)).toEqual([expect.objectContaining({ envelopeId: "envelope_movedopen1" })]);
    // The signed form moves with its evidence, every byte kept.
    expect(await requestByCustomer(signed)).toMatchObject({ familyQboId: "20", state: "complete", envelopeId: "envelope_movedsigned" });
    const [kept] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, evidence.id));
    // It names the new family's record now; its own copy of the QuickBooks ids stays as it was stored.
    expect(kept).toMatchObject({ requestId: signed, familyId: await recordOfCustomer("20", "family"), familyQboId: "10", subjectQboId: "12" });
    expect(await db.select().from(signedFormFile).where(eq(signedFormFile.evidenceId, evidence.id))).toHaveLength(4);
    // The place on a shift still to come is given up; the old family keeps nothing of the student's there.
    const [after] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, place.id));
    expect(after!.cancelledAt).not.toBeNull();
    expect((await auditsOf("roster.student.move.followed"))[0]).toMatchObject({ targetId: "12",
      after: { fromFamilyQboId: "10", toFamilyQboId: "20", formsMoved: 1, formsReset: 1, formsToWithdraw: 1, placesGivenUp: 1 } });
  });

  it("makes a family inactive in one action: everyone under it first, then the family, and its parents can no longer enter it", async () => {
    await seedParentSettings(SIGNINS_ON);
    const { ana } = await seedAnaRivera();
    expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
    stub.calls.length = 0;
    const r = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(r).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera, then Rivera Family." } });
    // QuickBooks is asked what each owes first, then sent three writes: the two under the family, then the family.
    expect(sent()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, Active: false }, { Id: "12", SyncToken: "0", sparse: true, Active: false },
      { Id: "10", SyncToken: "0", sparse: true, Active: false }]);
    const calls = stub.apiCalls().map((c) => `${c.method} ${c.path.replace(/^.*\/v3\/company\/\d+\//, "")}`);
    expect(calls.slice(0, 3).sort()).toEqual(["GET customer/10", "GET customer/11", "GET customer/12"]);
    // The family is read once more before its own write, for the version QuickBooks has now.
    expect(calls.slice(3)).toEqual(["POST customer", "POST customer", "GET customer/10", "POST customer"]);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: false });
    // Her row stays as it was: the gate keeps her out of a family whose record is inactive, and closes nothing.
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id)))[0]).toMatchObject({ status: "invited", disabledReason: null });
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect((await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY)))).toHaveLength(1);
    // Each write is audited as one write is, the family last; and one row says how the whole of it went.
    const rows = (await auditsOf("roster.customer.deactivate")).reverse();
    expect(rows.map((a) => [a.targetId, (a.after as { role: string }).role])).toEqual([["11", "parent"], ["12", "student"], ["10", "family"]]);
    expect(rows[2]!.after).toMatchObject({ active: false, refreshAsked: true });
    expect((await auditsOf("roster.family.deactivate"))[0]).toMatchObject({ targetId: "10", permission: "Roster.Family.ReadWrite", after: { outcome: "done", made: ["11", "12", "10"], notMade: [] } });
    expect(await queue()).toEqual([]);
  });

  it("lists everyone active under the family at any depth, deepest first, and leaves out the inactive", async () => {
    const company = fznCompany();
    (company.customers as Record<string, unknown>[]).push(
      { Id: "13", DisplayName: "Rivera Project", Active: true, SyncToken: "2", ParentRef: { value: "12" }, Job: true, MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" } },
      { Id: "14", DisplayName: "Old Rivera Student", Active: false, SyncToken: "0", ParentRef: { value: "10" }, Job: true, CustomerTypeRef: { value: "3" }, MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" } },
    );
    await resetDb(); stub.reset(); stub.quirks.balances = true;
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    tag = await connectRoster(stub, { company });
    const c = (await familyCover("10"))!;
    expect(c.family).toMatchObject({ qboId: "10", name: "Rivera Family" });
    expect(c.under.map((u) => [u.qboId, u.depth])).toEqual([["13", 2], ["11", 1], ["12", 1]]);
    expect(await askFamilyInactive("10", await shownFor("10"), tag, op)).toMatchObject({ result: { ok: true } });
    expect(sent().map((b) => b.Id)).toEqual(["13", "11", "12", "10"]);
    expect((await auditsOf("roster.customer.deactivate")).find((a) => a.targetId === "13")!.after).toMatchObject({ role: "other" });
  });

  it("refuses a list the page showed when someone has been added under the family since, and a family made inactive alone", async () => {
    const shown = await shownFor("10");
    expect(await askFamilyInactive("10", shown.filter(([id]) => id !== "12"), tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(await askFamilyInactive("10", shown.map(([id, t]): [string, string] => [id, id === "11" ? "7" : t]), tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(await askRosterWrite({ op: "deactivate", qboId: "10", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [familyHereWords("Rivera Family")] });
    expect(familyHereWords("Rivera Family")).toContain("“Make Rivera Family inactive”"); // the button as the page names it
    expect(await askFamilyInactive("20", shown, tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } }); // another family's list
    expect(await askFamilyInactive("12", shown, tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.gone] } });       // a student isn't a family
    expect(await askFamilyInactive("10", shown, "a-tag-of-another-company", op)).toEqual({ changed: false, result: { ok: false, errors: [ROSTER_MOVED] } });
    expect(stub.apiCalls().filter((c) => c.method === "GET" && c.path.includes("/customer/"))).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("refuses while a change to anyone under the family is waiting", async () => {
    await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" });
    expect(await askFamilyInactive("10", await shownFor("10"), tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.waiting] } });
    expect(posts()).toEqual([]);
  });

  it("makes a parent inactive in QuickBooks: the portal's own sign-in for them stays", async () => {
    await seedParentSettings(SIGNINS_ON);
    const { ana } = await seedAnaRivera();
    const r = await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op);
    expect(r.ok).toBe(true);
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id)))[0]).toMatchObject({ status: "invited", disabledReason: null });
    expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
    expect((await db.select().from(auditLog)).filter((a) => a.action === "parent.access.ended")).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]); // only a family's asks for a refresh
  });
});

describe("nobody with a balance is made inactive (the owner's decision of 2026-11-17)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const treasurer = async () => asOp(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));

  it("a balance on the family: nothing is sent, and staff are told who, with the amount only for Finance.Balance.Read", async () => {
    stub.invoices = [owes("901", "10", 42.5)];
    const shown = await shownFor("10");
    expect(await askFamilyInactive("10", shown, tag, op)).toEqual({ changed: false, result: { ok: false,
      errors: ["Rivera Family has an open balance in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] } });
    expect(await askFamilyInactive("10", shown, tag, { ...(await treasurer()), showAmounts: true })).toEqual({ changed: false, result: { ok: false,
      errors: ["Rivera Family owes $42.50 in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] } });
    expect(posts()).toEqual([]);
    expect(await cached("10")).toMatchObject({ active: true });
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "refused", code: "open_balance", made: [], notMade: ["11", "12", "10"] });
    expect(JSON.stringify(await audits())).not.toContain("42.5");
  });

  it("a balance on one member of the family: nobody is made inactive, the others neither", async () => {
    stub.invoices = [owes("902", "12", 15)];
    const r = await askFamilyInactive("10", await shownFor("10"), tag, { ...op, showAmounts: true });
    expect(r.result).toEqual({ ok: false, errors: ["Leo Rivera owes $15.00 in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: true });
  });

  it("a credit is left to QuickBooks: only an amount owed stops it", async () => {
    stub.invoices = [owes("903", "12", -20)];
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toMatchObject({ ok: true });
  });

  it("one student or parent with a balance is not made inactive either, and nothing is sent", async () => {
    stub.invoices = [owes("904", "12", 30)];
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op))
      .toEqual({ ok: false, errors: [`Leo Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, { ...op, showAmounts: true }))
      .toEqual({ ok: false, errors: [`Leo Rivera owes $30.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", role: "student", code: "open_balance" });
  });

  it("a balance that appears between the read and the write: QuickBooks' refusal (6220) is told in the same words, not as a code", async () => {
    // QuickBooks answers the read with no balance; the invoice lands just before the write.
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.invoices = [owes("905", "12", 30)]; };
    const one = await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op);
    expect(one).toEqual({ ok: false, errors: ["QuickBooks says there is a balance on Leo Rivera's account, so they weren't made inactive. It has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again."] });
    expect(JSON.stringify(one)).not.toMatch(/6220/);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", code: "fault_6220" });
    expect(await queue()).toEqual([]);
    // In the family action, the first one under it: nobody is made inactive, and the family is still active.
    stub.invoices = []; stub.onApiRequest = (c) => { if (c.method === "POST") stub.invoices = [owes("906", "11", 30)]; };
    const fam = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(fam).toEqual({ changed: false, result: { ok: false, errors: ["Nobody was made inactive.",
      "QuickBooks says there is a balance on Ana Rivera's account, so they weren't made inactive. It has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again.",
      "Not made inactive yet: Leo Rivera.", "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "fault_6220", made: [], notMade: ["11", "12", "10"] });
  });

  it("what is owed couldn't be read: nothing is sent; one student's change waits to reach QuickBooks as before, never sent", async () => {
    stub.dropApi = true;
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnread] });
    expect(await queue()).toEqual([]);
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toMatchObject({ ok: true, queued: true });
    expect((await queue())[0]).toMatchObject({ sent: false, lastCode: "unreachable" });
    expect(posts()).toEqual([]);
  });

  it("an answer with no balance in it isn't taken for nothing owed", async () => {
    stub.quirks.balances = false;
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect(posts()).toEqual([]);
  });
});

describe("making a family inactive can stop part way, says what is now true, and carries on when pressed again", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const CARRY_ON = "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active.";

  it("a refusal part way: who was made inactive, who wasn't and why, and the family still active; pressed again, it finishes", async () => {
    const shown = await shownFor("10");
    stub.onApiRequest = (c) => { stub.updateFault = c.method === "POST" && /"Id":"12"/.test(c.body) ? "6000" : null; };
    const first = await askFamilyInactive("10", shown, tag, op);
    expect(first).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.",
      "QuickBooks wouldn't make Leo Rivera inactive, so it wasn't changed. Check it in QuickBooks.", CARRY_ON] } });
    expect(await cached("11")).toMatchObject({ active: false });
    expect(await cached("12")).toMatchObject({ active: true });
    expect(await cached("10")).toMatchObject({ active: true });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12"]); // the family was never sent
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "fault_6000", made: ["11"], notMade: ["12", "10"] });
    expect(await queue()).toEqual([]);
    // Pressed again from the same page: Ana is inactive now and passed over; Leo and then the family are made inactive.
    stub.onApiRequest = null; stub.updateFault = null; stub.calls.length = 0;
    expect(await askFamilyInactive("10", shown, tag, op)).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Leo Rivera, then Rivera Family." } });
    expect(sent().map((b) => b.Id)).toEqual(["12", "10"]);
    expect(await cached("10")).toMatchObject({ active: false });
  });

  it("QuickBooks still refusing the family (800: someone under it the cache doesn't show yet): said in words, and the roster read again", async () => {
    // A customer under the family that QuickBooks has and the cache doesn't: QuickBooks refuses the family.
    stub.onApiRequest = (c) => { if (c.method === "POST" && /"Id":"10"/.test(c.body)) stub.customers.push({ Id: "19", DisplayName: "New Rivera", Active: true, SyncToken: "0", ParentRef: { value: "10" }, Job: true }); };
    const r = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera and Leo Rivera.",
      "QuickBooks won't make Rivera Family inactive while customers under it are still active, and it has someone under Rivera Family the roster here doesn't show yet, so Rivera Family wasn't changed. The roster is being read again: try again in a few minutes.", CARRY_ON] } });
    // Not a loop: the worker is asked to read the roster, after which the page lists the one QuickBooks has.
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    stub.onApiRequest = null;
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    expect((await familyCover("10"))!.under.map((u) => u.qboId)).toEqual(["19"]);
    expect(JSON.stringify(r)).not.toMatch(/\b800\b/);
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "stopped", code: "fault_800" });
  });

  it("QuickBooks can't be reached part way: it stops, the lost answer asks for a roster refresh, nothing is queued, and pressing again carries on", async () => {
    const shown = await shownFor("10");
    // The second write reaches QuickBooks, which makes Leo inactive, and the answer never comes back.
    stub.onApiRequest = (c) => { stub.loseUpdateAnswer = c.method === "POST" && /"Id":"12"/.test(c.body); };
    const first = await askFamilyInactive("10", shown, tag, op);
    expect(first.changed).toBe(true);
    expect(first.result).toEqual({ ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.",
      "The portal can't tell whether QuickBooks made Leo Rivera inactive: its answer didn't arrive. The roster is read again within a few minutes to see.", CARRY_ON] });
    expect(await queue()).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    expect(await cached("12")).toMatchObject({ active: true }); // left until the roster is read again: never guessed
    // The step that may have gone through is recorded apart, never as not made.
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "unreachable", made: ["11"], notMade: ["10"], maybe: ["12"] });
    // The roster is read again (the worker's refresh): Leo is inactive there. Pressed again, the family alone is sent.
    stub.onApiRequest = null; stub.loseUpdateAnswer = false;
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    expect((await askFamilyInactive("10", shown, tag, op)).result).toEqual({ ok: true, message: "Made Rivera Family inactive in QuickBooks." });
    expect(sent().map((b) => b.Id)).toEqual(["10"]);
  });

  it("QuickBooks turning the first write away unread (429): nothing was made inactive, the family is still active, nothing is queued", async () => {
    const shown = await shownFor("10");
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.rateLimitNext = 1; };
    const r = await askFamilyInactive("10", shown, tag, op);
    expect(r).toEqual({ changed: false, result: { ok: false, errors: ["Nobody was made inactive.",
      "QuickBooks couldn't take that just now, so Ana Rivera wasn't changed. Try again in a few minutes.", "Not made inactive yet: Leo Rivera.", CARRY_ON] } });
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: true });
    expect(await queue()).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]);
  });
});

describe("what QuickBooks shows of each record, read before anything is sent, and the family's own last step", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("a QuickBooks that raises a family's version when a customer under it changes: the family is sent with the version just read", async () => {
    stub.quirks.parentVersionFollows = true;
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toMatchObject({ ok: true });
    // Two customers under it were made inactive, so the family's version went from 0 to 2 before its own write.
    expect(sent().at(-1)).toEqual({ Id: "10", SyncToken: "2", sparse: true, Active: false });
    expect(await cached("10")).toMatchObject({ active: false });
  });

  it("a QuickBooks that leaves the family's version alone: the family is sent with the version the page showed", async () => {
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toMatchObject({ ok: true });
    expect(sent().at(-1)).toEqual({ Id: "10", SyncToken: "0", sparse: true, Active: false });
  });

  it("a version newer than the page's, before anything is sent: nothing is changed, the record is read again and the page made again", async () => {
    stub.customers.find((c) => c.Id === "12")!.SyncToken = "3"; // changed in QuickBooks since the roster was read
    const r = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Leo Rivera changed in QuickBooks since the page was shown, so nothing was changed. Look at the list again, and confirm it."] } });
    expect(posts()).toEqual([]);
    expect(await cached("12")).toMatchObject({ syncToken: "3" });
    // One student alone the same way: not sent, and shown as QuickBooks has it.
    const one = await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op);
    expect(one).toMatchObject({ ok: true });
    stub.customers.find((c) => c.Id === "21")!.SyncToken = "5";
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op)).toMatchObject({ ok: false, errors: [WRITE_COPY.changed], current: { name: "Mei Chen" } });
  });

  it("someone QuickBooks shows inactive already is passed over, and the roster is asked to be read again", async () => {
    stub.customers.find((c) => c.Id === "11")!.Active = false; // made inactive in QuickBooks; the cache doesn't know yet
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toEqual({ ok: true, message: "Made inactive in QuickBooks: Leo Rivera, then Rivera Family." });
    expect(sent().map((b) => b.Id)).toEqual(["12", "10"]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "done", alreadyInactive: ["11"] });
    // One alone: said, and shown as QuickBooks has it.
    stub.customers.find((c) => c.Id === "21")!.Active = false;
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op))
      .toMatchObject({ ok: false, errors: ["That is inactive in QuickBooks already, so there was nothing to change."], current: { active: false } });
  });

  it("the family's last step refused as changed (5010) says it changed while this was running, and the page is made again", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "10") c.SyncToken = "9"; }; // someone in QuickBooks, at that very moment
    const r = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera and Leo Rivera.",
      "Rivera Family changed in QuickBooks while this was running, so it wasn't made inactive. Press “Make Rivera Family inactive” again.",
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect(await cached("10")).toMatchObject({ active: true, syncToken: "9" });
  });

  it("the very first step refused as changed (5010): nothing is made inactive, and the page is made again with the record as it is now", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "11") c.SyncToken = "4"; };
    const r = await askFamilyInactive("10", await shownFor("10"), tag, op);
    expect(r.changed).toBe(true);
    expect((r.result as { errors: string[] }).errors.slice(0, 2)).toEqual(["Nobody was made inactive.",
      "Ana Rivera changed in QuickBooks since the page was shown, so it wasn't changed. Reload the page to see it as QuickBooks has it now."]);
    expect(await cached("11")).toMatchObject({ active: true, syncToken: "4" });
  });

  it("a balance read QuickBooks refuses outright says so, without asking to wait, and nothing is queued", async () => {
    stub.customers = stub.customers.filter((c) => c.Id !== "12"); // QuickBooks no longer answers for Leo: a 400
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.balanceRefused] });
    expect((await askFamilyInactive("10", await shownFor("10"), tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceRefused] });
    expect(WRITE_COPY.balanceRefused).not.toMatch(/try again in a few minutes/i);
    expect(await queue()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("two staff pressing at once: one makes them inactive, the other is stopped, and nobody is sent twice to any effect", async () => {
    const shown = await shownFor("10");
    const other = asOp(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const [a, b] = await Promise.all([askFamilyInactive("10", shown, tag, op), askFamilyInactive("10", shown, tag, other)]);
    expect([a, b].filter((x) => x.result.ok)).toHaveLength(1);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: false });
    expect((await auditsOf("roster.customer.deactivate")).map((x) => x.targetId).sort()).toEqual(["10", "11", "12"]);
  });

  it("waits for a roster read holding the lock, sending nothing meanwhile, then goes ahead", async () => {
    const shown = await shownFor("10");
    const lock = await holdTheRosterLock();
    let pending: Promise<unknown>;
    try {
      pending = askFamilyInactive("10", shown, tag, op);
      await untilALockIsAwaited();
      expect(stub.apiCalls().filter((c) => c.method === "POST" || c.path.includes("/customer/"))).toEqual([]);
    } finally { await lock.release(); }
    expect(await pending!).toMatchObject({ result: { ok: true } });
  });
});

describe("a make-inactive waiting on the queue reads what is owed before it is sent", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("one who owes is never sent: the item is stuck, with a code of its own", async () => {
    stub.invoices = [owes("907", "21", 25)];
    const item = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    stub.calls.length = 0;
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "open_balance", sent: false });
    expect(stub.apiCalls().map((c) => c.method)).toContain("GET");
    expect(posts()).toEqual([]);
    expect(await cached("21")).toMatchObject({ active: true });
  });

  it("one who owes nothing is read, then sent", async () => {
    const item = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(sent()).toEqual([{ Id: "21", SyncToken: "0", sparse: true, Active: false }]);
  });
});

describe("names: a taken one is answered with a free one to offer, never by failing (v1 spec §6.1)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("a name any customer has, inactive ones and those outside the portal too, is offered with a suffix, and nothing is sent", async () => {
    for (const [name, offer] of [["rivera family", "rivera family (2)"], ["Old Family", "Old Family (2)"], ["Lincoln High", "Lincoln High (2)"]]) {
      const r = await askRosterWrite({ op: "create", role: "family", name: name!, familyQboId: null, email: null, typeQboId: null }, tag, op);
      expect(r).toEqual({ ok: false, offer, errors: [expect.stringContaining(`You could use “${offer}”`)] });
    }
    expect(posts()).toEqual([]);
    // Staff accept the offer: it is sent as it was offered.
    expect((await askRosterWrite({ op: "create", role: "family", name: "Old Family (2)", familyQboId: null, email: null, typeQboId: null }, tag, op)).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Old Family (2)", CustomerTypeRef: { value: "1" } }]);
  });

  it("a name a waiting change will give someone is taken too", async () => {
    await seedQueued({ op: "create", role: "student", name: "Rosa Rivera", typeQboId: "3", familyQboId: "10", email: null });
    const r = await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op);
    expect(r).toMatchObject({ ok: false, offer: "Rosa Rivera (2)" });
  });

  it("a rename may keep its own name in another case, and not take another's", async () => {
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "LEO RIVERA" }, tag, op)).toMatchObject({ ok: true });
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Ana Rivera" }, tag, op)).toMatchObject({ ok: false, offer: "Ana Rivera (2)" });
  });

  it("a name QuickBooks still refuses as taken (a vendor or employee has it, 6240) is offered with the next suffix", async () => {
    stub.otherNames = ["Quinn Family"];
    const r = await askRosterWrite({ op: "create", role: "family", name: "Quinn Family", familyQboId: null, email: null, typeQboId: null }, tag, op);
    expect(r).toEqual({ ok: false, offer: "Quinn Family (2)", errors: [expect.stringContaining("Quinn Family (2)")] });
    expect(await queue()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "create", code: "fault_6240" });
  });

  it("a name with a colon, a tab or a line break, or too long, is refused before anything is sent", async () => {
    for (const name of ["Rivera:Leo", "Leo\tRivera", "Leo\nRivera", "x".repeat(101), "  "]) {
      expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name }, tag, op)).ok).toBe(false);
    }
    expect(posts()).toEqual([]);
  });
});

describe("a record that changed in QuickBooks meanwhile is never overwritten (v1 spec §6.3)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("is refused by QuickBooks (5010), read again, shown with its current values, and not queued", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") { c.DisplayName = "Leo R. Rivera"; c.SyncToken = "3"; } };
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.changed], current: { name: "Leo R. Rivera", active: true, familyName: "Rivera Family" } });
    expect(inStub("12")).toMatchObject({ DisplayName: "Leo R. Rivera", SyncToken: "3" });
    expect(await cached("12")).toMatchObject({ displayName: "Leo R. Rivera", syncToken: "3" }); // the cache took the newer record
    expect(await queue()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "rename", code: "fault_5010" });
  });
});

describe("what QuickBooks refuses, or can't be asked, is said and not queued; what may go through later is queued (v1 spec §4)", () => {
  it("a value QuickBooks won't take is refused", async () => {
    tag = await connectRoster(stub);
    stub.updateFault = "6000";
    const r = await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op);
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.refused] });
    expect(await queue()).toEqual([]);
    expect(await cached("12")).toMatchObject({ active: true });
  });

  it("not connected, a connection only an Admin can mend, and another company are said, and nothing is sent", async () => {
    tag = await connectRoster(stub);
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. (invalid_grant)" });
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.needsAdmin] });
    await db.update(qboConnection).set({ lastError: null, refreshTokenCiphertext: null });
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    await db.delete(qboConnection);
    await connectRoster(stub);
    await db.transaction((tx) => setRosterSource(tx, "4444")); // the cache came from another company
    const other = await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op);
    expect(other).toEqual({ ok: false, errors: [ROSTER_MOVED] }); // the page was shown the other roster
    expect(posts()).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("a page shown another company's roster changes nothing", async () => {
    tag = await connectRoster(stub);
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, "a-tag-of-another-company", op)).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(posts()).toEqual([]);
  });

  it("a write whose answer is lost is queued as one QuickBooks may have made; the cache is left until the roster is read again", async () => {
    tag = await connectRoster(stub);
    stub.loseUpdateAnswer = true;
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: true, queued: true, message: WRITE_COPY.queued });
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
    expect(await cached("12")).toMatchObject({ displayName: "Leo Rivera" });
    const [item] = await queue();
    expect(item).toMatchObject({ state: "waiting", sent: true, tries: 1, targetQboId: "12", familyId: await recordOfCustomer("10", "family"), studentId: await recordOfCustomer("12", "student"),
      realmId: REALM, askedByLabel: "registrar@club.org",
      request: { op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" } });
    expect(item!.lastCode).toMatch(/^(unreachable|timeout)$/);
    expect(item!.nextTryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await auditsOf("roster.write.queued"))[0]).toMatchObject({ targetId: item!.id, after: { op: "rename", sent: true } });
  });

  it("an unreachable QuickBooks and a 5xx are queued as possibly made; a 429 as not made", async () => {
    tag = await connectRoster(stub);
    stub.dropApi = true;
    expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.dropApi = false;
    // The 500 answers the write itself, not the read of what Mei owes before it.
    stub.onApiRequest = (c) => { if (c.method === "POST") { stub.failNext = 1; stub.onApiRequest = null; } };
    expect((await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.rateLimitNext = 1;
    expect((await askRosterWrite({ op: "create", role: "family", name: "Patel Family", familyQboId: null, email: null, typeQboId: null }, tag, op))).toMatchObject({ ok: true, queued: true });
    const items = await queue();
    expect(items.map((i) => [i.request.op, i.sent, i.lastCode])).toEqual([["rename", true, "unreachable"], ["deactivate", true, "http_500"], ["create", false, "http_429"]]);
    // Each filed under the app's records it is for: Leo and his family; Mei's family (a parent has no record of her own);
    // nothing for a new family, whose record is made once QuickBooks answers.
    const [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
    expect(items.map((i) => [i.request.op, i.familyId, i.studentId])).toEqual([["rename", rivera, leo], ["deactivate", chen, null], ["create", null, null]]);
  });

  it("a connection row held elsewhere while the token needs renewing is busy: queued as not sent, and the staff member never waits for it", async () => {
    tag = await connectRoster(stub);
    await db.update(qboConnection).set({ accessExpiresAt: new Date(Date.now() + 60_000) }); // within 5 minutes of expiring: the write must refresh first
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => { release = r; }), taken = new Promise<void>((r) => { locked = r; });
    const holding = db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); locked(); await held; });
    await taken;
    stub.calls.length = 0;
    try {
      const r = await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op);
      expect(r).toMatchObject({ ok: true, queued: true });
    } finally { release(); await holding; }
    expect((await queue())[0]).toMatchObject({ sent: false, lastCode: "token_busy" });
    expect(posts()).toEqual([]);
  });

  it("a second change to a record with one waiting is refused until it is done", async () => {
    tag = await connectRoster(stub);
    await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" });
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.update(writeQueue).set({ state: "stuck" });
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.update(writeQueue).set({ state: "done" });
    expect((await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).ok).toBe(true);
  });

  it("nobody is added to, or moved into, a family whose own change is still waiting", async () => {
    tag = await connectRoster(stub);
    await seedQueued({ op: "deactivate", role: "family", qboId: "20", syncToken: "0" });
    expect(await askRosterWrite({ op: "create", role: "parent", name: "Wen Chen", familyQboId: "20", email: "wen@example.com", typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(posts()).toEqual([]);
    await db.update(writeQueue).set({ state: "given_up" });
    expect((await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).ok).toBe(true);
  });
});

describe("every id the page sends is looked up on the roster, in the role the change needs", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const no = async (ask: Parameters<typeof askRosterWrite>[0], error: string) => expect(await askRosterWrite(ask, tag, op)).toEqual({ ok: false, errors: [error] });

  it("refuses customers outside the portal, strays, ids that aren't there, and the wrong role, before anything is sent", async () => {
    await no({ op: "rename", qboId: "30", syncToken: "0", name: "Lincoln Prep" }, WRITE_COPY.gone);    // a school
    await no({ op: "deactivate", qboId: "50", syncToken: "0" }, WRITE_COPY.gone);                      // a student under no family
    await no({ op: "deactivate", qboId: "60", syncToken: "0" }, WRITE_COPY.gone);                      // a customer of no type
    await no({ op: "deactivate", qboId: "999", syncToken: "0" }, WRITE_COPY.gone);
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "12", email: null, typeQboId: null }, WRITE_COPY.gone);  // a student isn't a family
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "30", email: null, typeQboId: null }, WRITE_COPY.gone);
    await no({ op: "move", qboId: "11", syncToken: "0", toFamilyQboId: "20" }, WRITE_COPY.notOffered);   // a parent isn't moved
    await no({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "21" }, WRITE_COPY.gone);         // to a parent, not a family
    await no({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "30" }, WRITE_COPY.gone);
    await no({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "10" }, "The student is in that family already, so there was nothing to change.");
    await no({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "40" }, "That family is inactive in QuickBooks, so nobody can be moved to it.");
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "40", email: null, typeQboId: null }, "This family is inactive in QuickBooks, so nobody can be added to it.");
    await no({ op: "deactivate", qboId: "40", syncToken: "0" }, "That is inactive in QuickBooks already, so there was nothing to change.");
    await no({ op: "create", role: "member", name: "Rosa", familyQboId: null, email: null, typeQboId: "1" }, WRITE_COPY.notOffered);
    expect(posts()).toEqual([]);
  });

  it("an id that isn't digits is never sent: the client refuses it", async () => {
    await db.update(qboCustomer).set({ qboId: "E2E-12" }).where(eq(qboCustomer.qboId, "12"));
    stub.calls.length = 0;
    const r = await askRosterWrite({ op: "deactivate", qboId: "E2E-12", syncToken: "0" }, tag, op);
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.notSent] });
    expect(stub.apiCalls()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ code: "bad_id" });
  });
});

describe("each membership shape allows what it allows (v1 spec §6.1)", () => {
  it("layered with no parent type: no parent can be added; students can", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    expect(await askRosterWrite({ op: "create", role: "parent", name: "Luis", familyQboId: "10", email: "luis@example.com", typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    expect((await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op)).ok).toBe(true);
  });

  it("layered with no student type: no student is added or moved", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    expect(await askRosterWrite({ op: "create", role: "student", name: "Rosa", familyQboId: "10", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] }); // not a student here
    expect(NOT_HERE.noStudents).toMatch(/can't tell a student/);
    expect(posts()).toEqual([]);
  });

  it("flat with several member types: a member is made with the type staff chose, and must be one", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    expect(await askRosterWrite({ op: "create", role: "member", name: "Sky Lee", familyQboId: null, email: null, typeQboId: null }, tag, op))
      .toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect(await askRosterWrite({ op: "create", role: "member", name: "Sky Lee", familyQboId: null, email: null, typeQboId: "1" }, tag, op))
      .toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect((await askRosterWrite({ op: "create", role: "member", name: "Sky Lee", familyQboId: null, email: null, typeQboId: "3" }, tag, op)).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "3" } }]);
    expect(await askRosterWrite({ op: "create", role: "family", name: "Lee Family", familyQboId: null, email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    expect(await askRosterWrite({ op: "create", role: "student", name: "Kim", familyQboId: "11", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    // A member is renamed and made inactive like anyone.
    expect((await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana R. Rivera" }, tag, op)).ok).toBe(true);
    expect((await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).ok).toBe(true);
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "11" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
  });

  it("flat with one member type: that type, without asking", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2"] } });
    expect((await askRosterWrite({ op: "create", role: "member", name: "Sky Lee", familyQboId: null, email: null, typeQboId: null }, tag, op)).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "2" } }]);
  });

  it("flat: a member's change that has to wait is filed under the member's own family record", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2"] } });
    stub.rateLimitNext = 1;
    expect(await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana R. Rivera" }, tag, op)).toMatchObject({ ok: true, queued: true });
    expect((await queue()).map((i) => [i.request.op, i.targetQboId, i.familyId, i.studentId])).toEqual([["rename", "11", await recordOfCustomer("11", "family"), null]]);
  });
});

describe("nothing of a refusal is kept but its code", () => {
  it("QuickBooks' words never reach the audit log", async () => {
    tag = await connectRoster(stub);
    stub.updateFault = "6000";
    await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op);
    expect(JSON.stringify(await audits())).not.toMatch(/must never store/);
    expect(fznCompany().customers.length).toBeGreaterThan(0);
  });
});
