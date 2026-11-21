import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import {
  accountingLink, accountingLinkEnded, auditLog, buyout, family, familyMoney, formReminderClaim, formReminderRound, formWithdrawal, guardian, jobRun, parent, parentAuthAccount,
  parentAuthSession, parentAuthUser, parentDevice, parentEmailChange, parentSigninToken, qboCheckRecord, qboCheckRun, qboConnection, qboCustomer, qboCustomerType, qboItem, requirement,
  requirementCover, requirementProgress, requirementReminder, season, seasonStep, setting, signatureConsent, signatureRequest, signedFormCopy, signedFormEvidence, signedFormFile,
  signinCode, student, volunteerCredit, volunteerEvent, volunteerReminder, volunteerShift, volunteerShiftRequirement, volunteerSignup, writeQueue,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { beginConnect, beginSwitchConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { NOT_SWITCHED_WORDS, refreshRoster } from "@/lib/roster/refresh";
import { evidenceDownload } from "@/lib/signed-forms/evidence";
import { clearRosterOfOtherCompany, getRosterSource, GIVEN_UP_FOR_COMPANY_NOTE, ROSTER_JOB, setRosterSource, SOURCE_KEY } from "@/lib/roster/source";
import { ROSTER_LOCK, SHAPE_KEY } from "@/lib/roster/shape";
import { RUN_KEY } from "@/lib/money/run-keys";
import { resetDb, seedStaff, untilALockIsAwaited } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";
import { recordOfCustomer } from "../helpers/app-records";
import { seedConsent } from "../helpers/forms";
import { mintLink, seedCode, seedDevice } from "../helpers/signin-links";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";

/**
 * What a change of company clears, and keeps, by open question 16 of the app-owned families spec (stage 4's slice
 * M7a): clearRosterOfOtherCompanyLocked() (src/lib/roster/source.ts). It ends every unpaid live buy-out as the earlier
 * company's and keeps paid ones counting; gives up the write queue's items still to go; deletes the money cache; moves
 * every link into the link history (`company_changed`) and clears the "Left unlinked" marks; and clears QuickBooks' own
 * copies (the customer list and types, the products and each payment requirement's product, the money run's place, the
 * check's records, the membership shape, the roster's runs and company). Everything else is kept as it was, row for
 * row: families, students, guardian rows, every sign-in, the seasons, volunteering and forms, and every signed form's
 * evidence, which stays its family's. Until slice M7a this file proved the clear deleted most of that; it flipped then.
 *
 * Since stage 4's slice M8 the portal reaches the clear when an Admin asks on the switch page and then connects another
 * company: the first describe calls it directly, and the last goes through the connect and the refresh.
 */
const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

/** Every row of a table, in a fixed order whatever order Postgres returns them in. */
const rowsOf = async (t: PgTable) => (await db.select().from(t)).map((r) => JSON.stringify(r)).sort();
/** The tables the clear keeps whole, each row for row. */
const KEPT = {
  parent, parentAuthUser, parentAuthAccount, parentAuthSession, parentDevice, signinCode, parentSigninToken, parentEmailChange, guardian, student,
  season, seasonStep, requirementCover, requirementProgress, requirementReminder,
  volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup, volunteerCredit, volunteerReminder,
  signatureRequest, signatureConsent, formReminderClaim, formReminderRound, formWithdrawal, signedFormEvidence, signedFormFile, signedFormCopy,
  qboConnection, qboCheckRun,
} as const;
const keptRows = async () => Object.fromEntries(await Promise.all(Object.entries(KEPT).map(async ([name, t]) => [name, await rowsOf(t)] as const)));
/** The settings but the three QuickBooks ones the clear changes: the shape, the roster's company, the money run's place. */
const otherSettings = async () => (await db.select().from(setting)).filter((s) => ![SHAPE_KEY, SOURCE_KEY, RUN_KEY].includes(s.key)).map((s) => JSON.stringify(s)).sort();
/** Every table, for "changed nothing". */
const everything = async () => ({ ...(await keptRows()), family: await rowsOf(family), requirement: await rowsOf(requirement), buyout: await rowsOf(buyout), writeQueue: await rowsOf(writeQueue),
  links: await rowsOf(accountingLink), ended: await rowsOf(accountingLinkEnded), money: await rowsOf(familyMoney), customers: await rowsOf(qboCustomer), types: await rowsOf(qboCustomerType),
  items: await rowsOf(qboItem), records: await rowsOf(qboCheckRecord), runs: await rowsOf(jobRun), settings: await rowsOf(setting), audit: await rowsOf(auditLog) });
const actionsWritten = async (...actions: string[]) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => actions.includes(r.action));

describe("connecting a different company, by open question 16", () => {
  beforeEach(async () => {
    await resetDb();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
  });

  it("ends the links into their history, gives up the queue, ends unpaid buy-outs and clears QuickBooks' copies, and keeps every other record as it was", async () => {
    const { a, b } = await seedTwoFamilies();
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    const famB = await recordOfCustomer(b.spec.family.qboId, "family");
    const studentA = await recordOfCustomer(a.spec.students[0]!.qboId, "student");
    // Something of every kept area beyond seedTwoFamilies()'s sessions, email changes, ticks, waivers, chosen lists,
    // sign-ups, credit, requests and evidence: reminder claims of each kind, a consent, a device, a code and a link.
    const [req] = await db.select().from(signatureRequest).limit(1);
    await db.insert(formReminderClaim).values({ requirementId: req!.requirementId, parentId: a.identity.parentId, onDate: "2026-11-16" });
    await db.insert(formReminderRound).values({ requirementId: req!.requirementId, onDate: "2026-11-16" });
    await db.insert(requirementReminder).values({ kind: "due_14", familyId: famA, parentId: a.identity.parentId, dueOn: "2026-11-30", triedAt: new Date(), outcome: "sent" });
    await db.insert(volunteerReminder).values({ kind: "due_14", key: `${String(famA)}|2026-11-30|${a.identity.parentId}`, familyId: famA, triedAt: new Date(), outcome: "sent" });
    await seedConsent(a.forms!.ids.waiting, { parentId: a.identity.parentId, name: a.spec.parent.name, email: a.spec.parent.email });
    await seedDevice(a.identity.parentId);
    await seedCode(a.identity.parentId);
    await mintLink(b.identity.parentId, "setup");
    // A queued change of each state but done, filed under A's family and student, and a done one.
    const rename = { op: "rename" as const, role: "student" as const, qboId: a.spec.students[0]!.qboId, syncToken: "0", name: "Aurelio Renamed", was: a.spec.students[0]!.name };
    const queued = await db.insert(writeQueue).values((["waiting", "stuck", "refused", "given_up", "done"] as const).map((state) => ({
      realmId: "1111", request: rename, targetQboId: rename.qboId, familyId: famA, studentId: studentA, state, sent: false,
      nextTryAt: state === "waiting" ? new Date() : null, finishedAt: state === "done" || state === "given_up" ? new Date() : null }))).returning();
    // A link an unlink ended (stage 4's slice M3b): kept, with the history the change of company adds.
    const [earlier] = await db.insert(accountingLinkEnded).values({ id: crypto.randomUUID(), system: "quickbooks", realmId: "1111", customerId: "9001", familyId: famA, origin: "carried_over",
      linkedAt: new Date(Date.now() - 60_000), endedAt: new Date(), endedBy: null, endedHow: "unlinked" }).returning();
    // A third family a staff member left unlinked: a statement about the old company's books.
    const [third] = await db.insert(family).values({ name: "Thornwick Unlinked Family", active: true, accountingLeftUnlinkedAt: new Date(), accountingLeftUnlinkedBy: crypto.randomUUID() }).returning();
    // B's form was kept while B had no QuickBooks link (as the evidence job keeps one since migration 0036): no company and no copy.
    await db.update(signedFormEvidence).set({ realmId: null, familyQboId: null, subjectQboId: null }).where(eq(signedFormEvidence.id, b.forms!.evidence.id));

    const kept = await keptRows();
    const before = {
      families: await db.select().from(family).orderBy(asc(family.id)), requirements: await db.select().from(requirement).orderBy(asc(requirement.id)),
      buyouts: await db.select().from(buyout).orderBy(asc(buyout.id)), queue: await db.select().from(writeQueue).orderBy(asc(writeQueue.id)),
      links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)), settings: await otherSettings(), audit: await db.select().from(auditLog).orderBy(asc(auditLog.id)),
    };
    // Something of each is there: both families' sessions, email changes, evidence, money, links, a buy-out of each (A's invoiced, B's paid).
    for (const name of ["parentAuthSession", "parentEmailChange", "parentDevice", "signinCode", "parentSigninToken", "requirementProgress", "requirementCover", "requirementReminder",
      "volunteerSignup", "volunteerCredit", "volunteerReminder", "signatureRequest", "signatureConsent", "formReminderClaim", "formReminderRound", "signedFormEvidence", "signedFormFile"] as const) {
      expect(kept[name]!.length, name).toBeGreaterThan(0);
    }
    expect(before.buyouts.map((x) => [String(x.familyId), x.state]).sort()).toEqual([[String(famA), "invoiced"], [String(famB), "paid"]].sort());
    expect((await db.select().from(familyMoney)).length).toBe(2);
    expect(before.links.length).toBeGreaterThanOrEqual(6);
    expect(before.links.every((l) => l.realmId === "1111")).toBe(true);
    expect(before.requirements.some((r) => r.itemQboId !== null)).toBe(true);

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);

    // Kept, row for row.
    expect(await keptRows()).toEqual(kept);
    expect(await otherSettings()).toEqual(before.settings);
    // Families: every one, every column, but the third's "Left unlinked" mark, cleared.
    const families = await db.select().from(family).orderBy(asc(family.id));
    expect(families).toEqual(before.families.map((f) => f.id === third!.id ? { ...f, accountingLeftUnlinkedAt: null, accountingLeftUnlinkedBy: null, updatedAt: expect.any(Date) } : f));
    // Requirements: every one, but each payment's product, which is the old company's (clearMoneyRecords(), as before).
    expect(await db.select().from(requirement).orderBy(asc(requirement.id)))
      .toEqual(before.requirements.map((r) => r.itemQboId === null ? r : { ...r, itemQboId: null, updatedAt: expect.any(Date) }));
    // Every open guardian row still names its app family.
    expect((await db.select().from(guardian)).every((g) => g.familyId !== null && g.status !== "disabled")).toBe(true);
    // Both families' evidence as it was: its request, family, student, company and copies, not archived.
    for (const e of await db.select().from(signedFormEvidence)) expect(e).toMatchObject({ requestId: expect.any(String), earlierCompanyAt: null, familyId: expect.any(String) });

    // The links: none left, every one in the history as it was, under its own id, `company_changed`; the earlier one kept.
    expect(await db.select().from(accountingLink)).toEqual([]);
    const ended = await db.select().from(accountingLinkEnded);
    expect(ended.find((l) => l.id === earlier!.id)).toEqual(earlier);
    for (const l of before.links) {
      expect(ended.find((x) => x.id === l.id)).toEqual({ id: l.id, system: l.system, realmId: l.realmId, customerId: l.customerId, familyId: l.familyId, studentId: l.studentId,
        guardianId: l.guardianId, origin: l.origin, linkedAt: l.linkedAt, linkedBy: l.linkedBy, endedAt: expect.any(Date), endedBy: null, endedHow: "company_changed", createdAt: expect.any(Date) });
    }
    expect(ended).toHaveLength(before.links.length + 1);

    // The queue: each item still to go given up, with the one note; the done and given-up ones as they were.
    const queue = await db.select().from(writeQueue).orderBy(asc(writeQueue.id));
    expect(queue).toEqual(before.queue.map((i) => ["waiting", "stuck", "refused"].includes(i.state)
      ? { ...i, state: "given_up", note: GIVEN_UP_FOR_COMPANY_NOTE, nextTryAt: null, finishedAt: expect.any(Date), updatedAt: expect.any(Date) } : i));
    expect(queued).toHaveLength(5);

    // Buy-outs: A's invoiced one ended as the earlier company's, its invoice kept; B's paid one as it was.
    const buyouts = await db.select().from(buyout).orderBy(asc(buyout.id));
    expect(buyouts).toEqual(before.buyouts.map((x) => x.state === "invoiced" ? { ...x, state: "voided", endReason: "earlier_company", updatedAt: expect.any(Date) } : x));
    expect(buyouts.find((x) => String(x.familyId) === String(famA))).toMatchObject({ invoiceQboId: "9174", realmId: before.buyouts.find((x) => String(x.familyId) === String(famA))!.realmId });

    // Cleared: the money cache and QuickBooks' own copies, the shape, the roster's runs; the roster names the new company.
    for (const t of [familyMoney, qboCustomer, qboCustomerType, qboItem, qboCheckRecord]) expect(await db.select().from(t)).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, SHAPE_KEY))).toEqual([]);
    expect(await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB))).toEqual([]);
    expect(await getRosterSource()).toBe("2222");

    // The audit rows: every earlier one kept, and those of the clear.
    const audit = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    expect(audit.slice(0, before.audit.length)).toEqual(before.audit);
    expect((await actionsWritten("roster.cleared")).map((r) => [r.before, r.after])).toEqual([[{ realmId: "1111" }, { reason: "different_company", realmId: "2222", writesGivenUp: 3 }]]);
    const [links] = await actionsWritten("accounting.links.cleared");
    expect(links!.after).toEqual({ reason: "different_company", realmId: "2222", links: before.links.length, endedAs: "company_changed",
      familyLinks: before.links.filter((l) => l.familyId !== null).length, studentLinks: before.links.filter((l) => l.studentId !== null).length,
      guardianLinks: before.links.filter((l) => l.guardianId !== null).length, leftUnlinkedCleared: 1, familiesKept: true, studentsKept: true, membershipsKept: true });
    const [ends] = await actionsWritten("volunteer.buyouts.ended");
    expect(ends!.after).toMatchObject({ ended: 1, endedIds: [before.buyouts.find((x) => x.state === "invoiced")!.id], paidKept: 1, sentToQuickBooks: false });
    expect(await actionsWritten("money.records.cleared")).toHaveLength(1);
    expect(await actionsWritten("parent.access.cleared", "season.records.cleared", "volunteer.signups.cleared", "form.records.cleared")).toEqual([]);

    // The same company again (the roster names "2222" now): nothing at all changes.
    const now = await everything();
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(false);
    expect(await everything()).toEqual(now);
  });

  it("changes nothing when the same company is connected, or the roster names none", async () => {
    await seedTwoFamilies();
    const before = await everything();
    expect(await clearRosterOfOtherCompany("1111", admin)).toBe(false);
    expect(await everything()).toEqual(before);
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    const none = await everything();
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(false);
    expect(await everything()).toEqual(none);
  });

  it("keeps evidence the worker was storing at that moment as its family's, with its request, once its store commits", async () => {
    const { a } = await seedTwoFamilies();
    const requestId = a.forms!.ids.signed;
    const familyId = a.identity.familyId;
    let commit!: () => void, inserted!: () => void;
    const held = new Promise<void>((resolve) => { commit = resolve; });
    const ready = new Promise<void>((resolve) => { inserted = resolve; });
    // As storeEvidence() does (stage 3's slice 9d): the roster lock held shared, the request locked, the evidence
    // inserted, the commit still to come. The clear, which holds the roster lock exclusively, waits for it.
    const storing = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
      await tx.select().from(signatureRequest).where(eq(signatureRequest.id, requestId)).for("update");
      await tx.insert(signedFormEvidence).values({ requestId, realmId: "1111", requirementId: null, familyQboId: a.spec.family.qboId, subjectQboId: a.spec.family.qboId,
        subjectKind: "family", familyId, formTitle: "In flight", envelopeId: "envelope_inflight", signers: [], consents: [], originals: [] });
      inserted();
      await held;
    });
    // The store holds its locks before the clear starts, so the lock the clear waits for is the store's.
    await ready;
    const clearing = clearRosterOfOtherCompany("2222", admin);
    await untilALockIsAwaited();
    commit();
    await storing;
    expect(await clearing).toBe(true);
    const [inFlight] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.formTitle, "In flight"));
    expect(inFlight).toMatchObject({ requestId, realmId: "1111", earlierCompanyAt: null, familyId });
  });

  // Flipped on purpose in stage 4's slice M8a: until then the filter read only the roster's company, so after the clear
  // a kept family's old customer's row was no longer found. Now it is, inside its earlier company's window.
  it("leaves the audit page's record filter finding a kept family's rows by its own id and by its old customer's number in the old company's time, never another's", async () => {
    const { a, b } = await seedTwoFamilies();
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    const staffActor = { door: "staff" as const, id: null, label: "registrar@club.org" };
    const read = (targetType: string, targetId: string, tag: string) => writeAudit({ actor: staffActor, action: "roster.family.read", targetType, targetId, after: { tag } });
    // A row naming A's app family, one naming A's customer (as rows did before the area moved to the app's ids), and one naming B's customer.
    await read("family", String(famA), "a-record");
    await read("qbo_customer", a.spec.family.qboId, "a-customer-old");
    await read("qbo_customer", b.spec.family.qboId, "b-customer-old");
    const found = async () => (await auditPage(parseAuditFilters({ record: `family:${String(famA)}` }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    // Before: through A's link in the roster's company, its customer's row is A's.
    expect(await found()).toEqual(["a-customer-old", "a-record"]);
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // After, until A is linked in the new company: the filter reads A's link the clear ended (`company_changed`), cut to
    // the old company's time as the roster's (the `roster.cleared` row bounds it), so its old customer's row is still
    // A's and B's row is not; a row of that number written since names the new company's customer, which may be anyone.
    await read("qbo_customer", a.spec.family.qboId, "a-number-since");
    expect(await found()).toEqual(["a-customer-old", "a-record"]);
    // Linked in the new company to the number B's customer had in the old one: B's old row is still never A's, as the
    // new link's window opens when the new company's time does, and a row naming that number written since is A's.
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "2222", customerId: b.spec.family.qboId, familyId: famA, origin: "confirmed",
      linkedBy: "00000000-0000-4000-8000-0000000000aa" });
    await read("qbo_customer", b.spec.family.qboId, "b-number-in-new-company");
    expect(await found()).toEqual(["a-customer-old", "a-record", "b-number-in-new-company"]);
  });

  it("names the staff member who connected the new company as the one who ended each link", async () => {
    await seedTwoFamilies();
    const staff = await seedStaff({ email: "connector@club.org", admin: true });
    const links = await db.select().from(accountingLink);
    expect(links.length).toBeGreaterThan(0);
    expect(await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: staff.id, label: staff.email }, ip: null })).toBe(true);
    const ended = await db.select().from(accountingLinkEnded);
    expect(ended.map((l) => l.id).sort()).toEqual(links.map((l) => l.id).sort());
    for (const l of ended) expect(l).toMatchObject({ endedHow: "company_changed", endedBy: staff.id });
  });
});

describe("switching companies keeps the seasons', volunteering's and forms' records", () => {
  const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
  const audits = async (...actions: string[]) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => actions.includes(r.action));
  /** Every season and volunteering record, ids and times and all, and the app's own records they name. */
  const seasonRecords = async () => ({
    progress: await db.select().from(requirementProgress).orderBy(asc(requirementProgress.id)),
    covers: await db.select().from(requirementCover).orderBy(asc(requirementCover.requirementId), asc(requirementCover.familyId), asc(requirementCover.studentId)),
    reminders: await db.select().from(requirementReminder).orderBy(asc(requirementReminder.id)),
    signups: await db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.id)),
    credits: await db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.id)),
    volunteerReminders: await db.select().from(volunteerReminder).orderBy(asc(volunteerReminder.id)),
    // Buy-outs (stage 2): every one, by the app's own family and student.
    buyouts: await db.select().from(buyout).orderBy(asc(buyout.id)),
    // The money cache (stage 2): every family's stored figures, by the app's own family.
    money: await db.select().from(familyMoney).orderBy(asc(familyMoney.familyId)),
    families: await db.select().from(family).orderBy(asc(family.id)),
    students: await db.select().from(student).orderBy(asc(student.id)),
    links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
    // Forms (stage 2): every request, consent, reminder claim and round, and every piece of kept evidence with its files and copies.
    requests: await db.select().from(signatureRequest).orderBy(asc(signatureRequest.id)),
    consents: await db.select().from(signatureConsent).orderBy(asc(signatureConsent.id)),
    formClaims: await db.select().from(formReminderClaim).orderBy(asc(formReminderClaim.id)),
    formRounds: await db.select().from(formReminderRound).orderBy(asc(formReminderRound.id)),
    evidence: await db.select().from(signedFormEvidence).orderBy(asc(signedFormEvidence.id)),
    files: await db.select().from(signedFormFile).orderBy(asc(signedFormFile.id)),
    copies: await db.select().from(signedFormCopy).orderBy(asc(signedFormCopy.id)),
  });
  /** What a switch keeps: all of it but the buy-outs (the unpaid ones end), the money cache and the links (both cleared). */
  const keptOf = (r: Awaited<ReturnType<typeof seasonRecords>>) => Object.fromEntries(Object.entries(r).filter(([k]) => !["buyouts", "money", "links"].includes(k)));
  let staff: Awaited<ReturnType<typeof seedStaff>>;
  const op = () => ({ actor: { door: "staff" as const, id: staff.id, label: staff.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" });
  /** A connect through Intuit: a plain one, or one asked for on the switch page (beginSwitchConnect()). */
  const connect = async (realmId: string, o: { switching?: boolean } = {}) => {
    const r = o.switching ? await beginSwitchConnect(staff.id, op()) : await beginConnect(staff.id);
    if (!r.ok) throw new Error("not configured");
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", state: new URL(r.url).searchParams.get("state"), realmId, error: null },
      { staffUserId: staff.id, actor: { door: "staff", id: staff.id, label: staff.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" });
  };

  beforeEach(async () => {
    await resetDb(); stub.reset();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    staff = await seedStaff({ email: "admin@example.org", admin: true });
  });

  // Flipped on purpose in stage 4's slice M8: until then a different company was refused (open question 18). Now one
  // connected after the ask clears what open question 16 says and keeps every season, volunteering and forms record.
  it("connects another company after the ask, keeps the season's, volunteering's and forms' records, and its staff still download the evidence", { timeout: 30_000 }, async () => {
    const { a, b } = await seedTwoFamilies();
    // A due-date reminder claim of each, carried by the app's own family (src/lib/seasons/due-reminders.ts, src/lib/volunteer/reminders.ts).
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    await db.insert(requirementReminder).values({ kind: "due_14", familyId: famA, parentId: a.identity.parentId, dueOn: "2026-11-30", triedAt: new Date(), outcome: "sent" });
    await db.insert(volunteerReminder).values({ kind: "due_14", key: `${String(famA)}|2026-11-30|${a.identity.parentId}`, familyId: famA, triedAt: new Date(), outcome: "sent" });
    // A guardian's consent to sign, and a form reminder's claim and round.
    await seedConsent(a.forms!.ids.waiting, { parentId: a.identity.parentId, name: a.spec.parent.name, email: a.spec.parent.email });
    const [req] = await db.select().from(signatureRequest).limit(1);
    await db.insert(formReminderClaim).values({ requirementId: req!.requirementId, parentId: a.identity.parentId, onDate: "2026-11-16" });
    await db.insert(formReminderRound).values({ requirementId: req!.requirementId, onDate: "2026-11-16" });
    await seedConnected(stub, { realmId: "1111" });
    const before = await seasonRecords();
    // Both families' requests in every state, a consent, the kept evidence of each with its four files, the claim and round.
    expect(new Set(before.requests.map((r) => r.state))).toEqual(new Set(["not_opened", "waiting", "signed", "complete", "declined"]));
    expect(before.requests.length).toBeGreaterThanOrEqual(12);
    expect(before.consents).toHaveLength(1);
    expect(before.evidence).toHaveLength(2);
    expect(before.files).toHaveLength(8);
    expect([before.formClaims.length, before.formRounds.length]).toEqual([1, 1]);
    // Something of each is there to keep: both families' ticks and waivers, their chosen lists, the claim.
    expect(before.progress.filter((p) => p.metAt !== null).length).toBeGreaterThanOrEqual(4);
    expect(before.progress.filter((p) => p.waivedAt !== null).length).toBeGreaterThanOrEqual(2);
    expect(before.covers.length).toBeGreaterThanOrEqual(4);
    expect(before.reminders).toHaveLength(1);
    expect(b.season!.markers.length).toBeGreaterThan(0);
    // Both families' places on the shared shift, A's check-in and B's credit from outside the portal, the claim.
    expect(before.signups.length).toBeGreaterThanOrEqual(2);
    expect(before.credits.length).toBeGreaterThanOrEqual(2);
    expect(before.volunteerReminders).toHaveLength(1);

    expect(before.links.length).toBeGreaterThan(0);
    expect(before.buyouts.map((x) => x.state).sort()).toEqual(["invoiced", "paid"]);

    // The Admin disconnects, says on the switch page they mean to, and signs in to Intuit with another company.
    await disconnect({ actor: { door: "staff", id: staff.id, label: staff.email }, ip: null });
    expect(await connect("2222", { switching: true })).toEqual({ ok: true });
    expect((await db.select().from(qboConnection))[0]!.realmId).toBe("2222");
    expect(await getRosterSource()).toBe("2222");
    const after = await seasonRecords();
    expect(keptOf(after)).toEqual(keptOf(before));
    expect(after.links).toEqual([]);
    expect(after.money).toEqual([]);
    // The paid buy-out keeps counting, unchanged; the invoiced one ends as the earlier company's, its invoice kept on it.
    const paid = before.buyouts.find((x) => x.state === "paid")!, invoiced = before.buyouts.find((x) => x.state === "invoiced")!;
    expect(after.buyouts.find((x) => x.id === paid.id)).toEqual(paid);
    expect(after.buyouts.find((x) => x.id === invoiced.id)).toMatchObject({ state: "voided", endReason: "earlier_company", invoiceQboId: invoiced.invoiceQboId, realmId: invoiced.realmId });
    expect(await audits("roster.cleared")).toHaveLength(1);
    expect(await audits("accounting.links.cleared")).toHaveLength(1);
    expect(await audits("season.records.cleared", "volunteer.signups.cleared", "parent.access.cleared", "form.records.cleared")).toEqual([]);

    // The first read of the new company changes none of it, and the evidence still downloads for staff (the owner's choice 2).
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(keptOf(await seasonRecords())).toEqual(keptOf(before));
    for (const e of before.evidence) {
      const sealed = before.files.find((x) => x.evidenceId === e.id && x.kind === "sealed_pdf" && x.position === 1)!;
      const got = await evidenceDownload(e.id, "sealed-pdf-1");
      expect(got && Buffer.from(got.bytes).equals(Buffer.from(sealed.bytes))).toBe(true);
    }
    expect(await audits("roster.cleared")).toHaveLength(1);
  });

  // Flipped on purpose in stage 4's slice M8: a switch the connect stored, whose clear never ran, is cleared by the next
  // refresh, keeping every season record; a connection to another company with no recorded switch is still never read.
  it("a refresh clears for a switch the connect recorded, asking nothing first without one, and keeps every season record", { timeout: 30_000 }, async () => {
    await seedTwoFamilies();
    // A connection to another company stored without a connect (from before the refusal, or by hand): never read.
    await seedConnected(stub, { realmId: "2222" });
    const before = await seasonRecords();
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed", error: NOT_SWITCHED_WORDS });
    expect(stub.apiCalls()).toEqual([]);
    expect(await getRosterSource()).toBe("1111");
    expect(await seasonRecords()).toEqual(before);
    expect((await audits("roster.refresh.failed")).map((r) => r.after)).toEqual([{ code: "roster_company" }]);
    expect(before.signups.length).toBeGreaterThanOrEqual(2);
    expect(await audits("roster.cleared")).toEqual([]);

    // As the connect's store leaves it when its clear (step 3b) doesn't run: the switch recorded beside the connection.
    await db.insert(setting).values({ key: "quickbooks.switch", value: { stored: { fromRealmId: "1111", toRealmId: "2222", staffUserId: staff.id, at: new Date().toISOString() } } });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await getRosterSource()).toBe("2222");
    expect((await db.select().from(setting).where(eq(setting.key, "quickbooks.switch")))).toEqual([]);
    const after = await seasonRecords();
    expect(keptOf(after)).toEqual(keptOf(before));
    expect(after.links).toEqual([]);
    expect((await audits("roster.cleared")).map((r) => r.after)).toEqual([expect.objectContaining({ reason: "different_company", realmId: "2222" })]);
    expect(await audits("season.records.cleared", "volunteer.signups.cleared", "parent.access.cleared", "form.records.cleared")).toEqual([]);
  });

  // Stage 4's slice M8a: the audit page's record filter reads what the connect's clear writes (the `company_changed`
  // links and the `roster.cleared` row), so a kept family's earlier rows are found in the old company's time only.
  it("leaves the audit page's record filter finding a kept family's old company's rows after a switch through the connect, and never the new company's of the same number", { timeout: 30_000 }, async () => {
    const { a, b } = await seedTwoFamilies();
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    await seedConnected(stub, { realmId: "1111" });
    const read = (customerId: string, tag: string) => writeAudit({ actor: { door: "staff", id: staff.id, label: staff.email }, action: "roster.family.read",
      targetType: "qbo_customer", targetId: customerId, after: { tag } });
    const found = async () => (await auditPage(parseAuditFilters({ record: `family:${String(famA)}` }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    await read(a.spec.family.qboId, "a-old");
    await read(b.spec.family.qboId, "b-old");
    expect(await found()).toEqual(["a-old"]);

    await disconnect({ actor: { door: "staff", id: staff.id, label: staff.email }, ip: null });
    expect(await connect("2222", { switching: true })).toEqual({ ok: true });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await audits("roster.cleared")).toHaveLength(1);
    // A's link of the old company ended `company_changed`; A has none in the new one.
    expect((await db.select().from(accountingLinkEnded).where(eq(accountingLinkEnded.familyId, famA))).map((l) => [l.realmId, l.endedHow])).toEqual([["1111", "company_changed"]]);
    // In the new company's time, a row naming A's old number is another customer's.
    await read(a.spec.family.qboId, "a-number-since");
    expect(await found()).toEqual(["a-old"]);
    // Linked in the new company to B's old number: B's old row is never A's, and one written since is.
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "2222", customerId: b.spec.family.qboId, familyId: famA, origin: "confirmed", linkedBy: staff.id });
    await read(b.spec.family.qboId, "b-number-in-new-company");
    expect(await found()).toEqual(["a-old", "b-number-in-new-company"]);
  });
});
