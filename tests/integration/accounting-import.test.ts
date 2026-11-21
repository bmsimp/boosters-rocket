import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
// Mail is sent nowhere: only once a test sets mail up as working (seedWorkingMail()), into this outbox.
type Msg = { to: string; subject: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parent, parentSigninToken, qboCustomer, student, writeQueue } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import { loadAccountingLinks } from "@/lib/accounting/mapping";
import { IMPORT_MAX, importKeys } from "@/lib/accounting/import-proposals";
import { IMPORT_COPY, saveImport } from "@/lib/accounting/import-writes";
import { importStamp } from "@/lib/accounting/stamp";
import { PARENTS_KEY } from "@/lib/parents/settings";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { refreshRoster } from "@/lib/roster/refresh";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { saveImportAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedGuardianInFamily, seedParent, seedWorkingMail, untilALockIsAwaited } from "../helpers/db";
import { seedParentSettings } from "../helpers/roster-cache";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { connectRoster, REALM, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";
import { linkRows } from "../helpers/signin-links";

/**
 * The reviewed import (stage 4's slice M6 of the app-owned families spec, section 4 and open question 4;
 * src/lib/accounting/import-writes.ts): Propose families from the books on Accounting links, reviewed, then saved in one
 * press. The company is fznCompany()'s (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3, School 4; the Rivera
 * (10) and Chen (20) families have their records. Added in QuickBooks and read by a roster read: the Patels (70) and the
 * Okafors (80), whose Parent customers Nita and Raj, and Ada and Nita again, give the guardians. Raj is a person the
 * portal has (a guardian of the Riveras), welcomed before; Nita's address is under both families.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); outbox.length = 0; });

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
const BOOKS = [
  qc("70", "Patel Family", "1", mail("patels@example.com")), qc("71", "Asha Patel", "3", { ...under("70"), ...mail("asha@example.com") }), qc("72", "Ravi Patel", "3", { ...under("70"), Active: false }),
  qc("73", "Nita Patel", "2", { ...under("70"), ...mail("Nita@Example.com") }), qc("74", "Raj Patel", "2", { ...under("70"), ...mail("raj@example.com") }),
  qc("80", "Okafor Family", "1"), qc("81", "Ike Okafor", "3", under("80")), qc("83", "Ada Okafor", "2", { ...under("80"), ...mail("ada@example.com") }),
  qc("84", "Nita Okafor", "2", { ...under("80"), ...mail("nita@example.com") }),
];

/** The club: the company read, the Patels and Okafors added in QuickBooks, Leo Rivera moved under the Patels there, and Raj in the portal already. */
async function club(o: { welcomes?: boolean } = {}) {
  const tag = await connectRoster(stub);
  stub.customers = stub.customers.map((c) => (c.Id === "12" ? { ...c, ...under("70") } : c));
  stub.customers.push(...BOOKS);
  const read = await refreshRoster(WORKER);
  if (!read.ok) throw new Error(`the roster couldn't be read: ${JSON.stringify(read)}`);
  const raj = await seedParent({ name: "Raj in the portal", email: "raj@example.com", welcomedAt: new Date("2026-01-01T00:00:00Z") });
  await seedGuardianInFamily({ parentId: raj.id, familyQboId: "10" });
  await seedParentSettings({ signin: true, welcome: o.welcomes ?? false });
  const linker = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
  return { tag, raj, linker };
}
const linkOp = (s: { id: string; email: string }) => ({ actor: { door: "staff" as const, id: s.id, label: s.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: s.id });
/** The review as the page draws it: the proposal, the ids in its order and the stamp the press is bound to. */
async function review() {
  const r = (await (await loadAccountingLinks()).importReview())!;
  return { ...r, ids: r.proposal.families.map((f) => f.customerId), stamp: importStamp(importKeys(r.proposal.families)) };
}
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const familyOf = async (customerId: string) => (await db.select({ familyId: accountingLink.familyId }).from(accountingLink)
  .where(and(eq(accountingLink.realmId, REALM), eq(accountingLink.customerId, customerId), isNotNull(accountingLink.familyId))))[0]?.familyId ?? null;
const linkOf = async (customerId: string, kind: "student" | "guardian") => (await db.select().from(accountingLink)
  .where(and(eq(accountingLink.realmId, REALM), eq(accountingLink.customerId, customerId), isNotNull(kind === "student" ? accountingLink.studentId : accountingLink.guardianId))))[0];
const tokenOf = async (id: string) => (await db.select({ t: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, id)))[0]!.t;
const personAt = async (email: string) => (await db.select().from(parent).where(eq(parent.email, email)))[0];
const rowsOf = async (familyId: AppFamilyId) => db.select({ parentId: guardian.parentId, status: guardian.status, id: guardian.id }).from(guardian).where(eq(guardian.familyId, familyId));
/** Everything the import may make, to prove a refusal made nothing. */
const madeSoFar = async () => ({ families: (await db.select().from(family)).length, students: (await db.select().from(student)).length,
  links: (await db.select().from(accountingLink)).length, people: (await db.select().from(parent)).length, rows: (await db.select().from(guardian)).length,
  audits: (await db.select().from(auditLog).where(sql`${auditLog.action} like 'accounting.%' or ${auditLog.action} like 'parent.%'`)).length });

/** A transaction holding a lock until released: the parents' settings lock (which every guardian write takes first) or the roster lock, exclusively. */
async function hold(lock: "settings" | "roster"): Promise<{ release: () => Promise<void> }> {
  let release = () => {};
  let done: Promise<void> = Promise.resolve();
  await new Promise<void>((took) => {
    done = db.transaction(async (tx) => {
      await tx.execute(lock === "settings" ? sql`select pg_advisory_xact_lock(hashtext(${PARENTS_KEY}))` : sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      took();
      await new Promise<void>((r) => { release = () => r(); });
    });
  });
  return { release: async () => { release(); await done; } };
}

describe("the review", () => {
  it("proposes the families no family is linked to, with their students and guardians, as the page shows them, and writes nothing", async () => {
    const { linker } = await club();
    const r = await review();
    expect(r.welcomes).toBe(false);
    expect(r.proposal).toMatchObject({ aimed: 0, pastCap: 0, from: "parent_customer" });
    expect(r.ids).toEqual(["80", "70"]); // the roster's order: by name
    const patels = r.proposal.families[1]!;
    expect(patels.students.made.map((s) => s.name)).toEqual(["Asha Patel", "Ravi Patel"]);
    expect(patels.students.leftAlone.map((s) => s.name)).toEqual(["Leo Rivera"]);
    expect(patels.guardians.map((g) => [g.email, g.link?.qboId, g.person.kind, g.alsoIn])).toEqual([
      ["nita@example.com", "73", "new", ["Okafor Family"]], ["raj@example.com", "74", "existing", []]]);
    expect(patels.guardians[1]!.person).toMatchObject({ name: "Raj in the portal", families: ["Rivera Family"] });

    const audited = (await db.select().from(auditLog)).length;
    asStaff(linker);
    const html = await renderPage(AccountingLinksPage, { searchParams: { import: "1" } });
    const part = html.slice(html.indexOf('id="import-h"'), html.indexOf("</section>", html.indexOf('id="import-h"'))).replaceAll("&#x27;", "'").replaceAll("<!-- -->", "");
    expect(part).toContain("Nothing is sent to QuickBooks. Families, students and people the portal has already are never changed");
    expect(part).toContain("Welcome emails are off, so nobody is mailed now");
    expect(part).toContain("A family you untick stays in the list of customers with no family");
    expect(part).toContain('type="checkbox" checked=""');
    expect(part).toContain("Make these families (2)");
    expect(part).toContain("Raj in the portal (raj@example.com), whom the portal has already, a guardian of Rivera Family now, added with their name as it is, linked to the Parent customer “Raj Patel”.");
    expect(part).toContain("The same address is proposed for Okafor Family too: one person, a guardian of each.");
    expect(part).toContain("Left as they are, as the portal has a record of them already: Leo Rivera.");
    // The offer, in the part for the customers no family is linked to.
    const offer = html.slice(html.indexOf('id="no-family-h"'), html.indexOf("</section>", html.indexOf('id="no-family-h"')));
    expect(offer).toContain('href="/staff/links?import=1#import-h"');
    // Not audited, and nothing made.
    expect((await db.select().from(auditLog)).length).toBe(audited);
    expect(await familyOf("70")).toBeNull();
  });

  it("tells a holder of the linking permission alone that someone who may change families makes the import, and shows them no review", async () => {
    await club();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    const html = (await renderPage(AccountingLinksPage, { searchParams: { import: "1" } })).replaceAll("&#x27;", "'");
    expect(html).toContain("Someone who may change families can propose families from the books here");
    expect(html).not.toContain('href="/staff/links?import=1#import-h"');
    expect(html).toContain("Proposing families from the books takes the permission that changes families too");
    expect(html).not.toContain("Make these families");
  });
});

describe("Make these families", () => {
  it("makes the families and students linked confirmed, adds and links the guardians, audits each, and sends and queues nothing", async () => {
    const { tag, raj, linker } = await club();
    // What exists and must not change: a family renamed in the portal, a hand-made family with no link, a person, a student record.
    const rivera = await recordOfCustomer("10", "family");
    await db.update(family).set({ name: "The Riveras, as the portal calls them" }).where(eq(family.id, rivera));
    const [quiet] = await db.insert(family).values({ name: "Our Quiets", active: true }).returning();
    const leo = await recordOfCustomer("12", "student");
    const before = { rivera: await db.select().from(family).where(eq(family.id, rivera)), quiet: await db.select().from(family).where(eq(family.id, quiet!.id)),
      raj: await db.select().from(parent).where(eq(parent.id, raj.id)), leo: await db.select().from(student).where(eq(student.id, leo)), leoLink: await linkOf("12", "student") };
    const calls = stub.apiCalls().length;
    const r = await review();
    const done = await saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.message).toBe("2 families made in the portal, each linked to its customer: Okafor Family and Patel Family."
      + " 3 students made, each linked to their own customer. 1 student under them already had a record in the portal and was left as it was."
      + " 4 guardians added, as on a family's page, for 2 new people and 1 person the portal had already, their names as they were."
      + " 4 guardians were linked to their own Parent customer in the books."
      + " Welcome emails are off, so nobody was mailed: each person added is welcomed, with a link to set up their sign-in, once an Admin switches welcome emails on."
      + " " + IMPORT_COPY.nothingSent + " " + IMPORT_COPY.money);

    // The families and students, linked confirmed by the staff member with the cache's versions.
    const patels = (await familyOf("70"))!, okafors = (await familyOf("80"))!;
    expect(await db.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, patels))).toEqual([{ name: "Patel Family", active: true }]);
    for (const id of ["70", "80"]) {
      const [l] = await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, id), isNotNull(accountingLink.familyId)));
      expect(l, id).toMatchObject({ origin: "confirmed", linkedBy: linker.id, syncedToken: await tokenOf(id) });
    }
    for (const id of ["71", "72", "81"]) expect(await linkOf(id, "student"), id).toMatchObject({ origin: "confirmed", linkedBy: linker.id, syncedToken: await tokenOf(id) });
    expect((await db.select({ name: student.name }).from(student).where(eq(student.familyId, patels))).map((s) => s.name).sort()).toEqual(["Asha Patel", "Ravi Patel"]);
    // The guardians: Nita one person in both families, named from the first family made; Raj reused, his name unchanged.
    const nita = (await personAt("nita@example.com"))!;
    expect(nita).toMatchObject({ name: "Nita Okafor", blocked: false, welcomeOwed: false });
    expect((await rowsOf(patels)).map((g) => [g.parentId, g.status]).sort()).toEqual([[nita.id, "invited"], [raj.id, "invited"]].sort());
    expect((await rowsOf(okafors)).map((g) => g.parentId).sort()).toEqual([nita.id, (await personAt("ada@example.com"))!.id].sort());
    for (const [customer, email, familyId] of [["73", "nita@example.com", patels], ["74", "raj@example.com", patels], ["83", "ada@example.com", okafors], ["84", "nita@example.com", okafors]] as const) {
      const l = await linkOf(customer, "guardian");
      const p = (await personAt(email))!;
      const [row] = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyId, familyId)));
      expect(l, customer).toMatchObject({ guardianId: row!.id, origin: "confirmed", linkedBy: linker.id, syncedToken: await tokenOf(customer) });
    }

    // The audit rows, by action and target.
    const [saved] = (await audits("accounting.import.save")).filter((a) => a.targetId === done.pressId);
    expect(saved).toMatchObject({ actorId: linker.id, permission: "Accounting.Link.ReadWrite", targetType: "accounting_link" });
    expect(saved!.after).toMatchObject({ pressId: done.pressId, realmId: REALM, families: 2, studentsMade: 3, studentsLeftAlone: 1, guardiansProposed: 4 });
    expect((saved!.after as { familyIds: string[] }).familyIds.sort()).toEqual([String(okafors), String(patels)].sort());
    for (const f of [patels, okafors]) {
      const [row] = (await audits("accounting.family.from_customer")).filter((a) => a.targetId === String(f));
      expect(row!.after, String(f)).toMatchObject({ import: done.pressId, realmId: REALM });
    }
    const granted = (await audits("parent.access.granted")).filter((a) => (a.after as { import?: string }).import === done.pressId);
    expect(granted).toHaveLength(4);
    expect(granted.every((a) => a.permission === "Roster.Family.ReadWrite" && (a.after as { addedBy: string }).addedBy === "import")).toBe(true);
    expect((await audits("parent.create")).filter((a) => (a.after as { import?: string }).import === done.pressId).map((a) => (a.after as { email: string }).email).sort()).toEqual(["ada@example.com", "nita@example.com"]);
    expect((await audits("accounting.link.guardian")).filter((a) => (a.after as { import?: string }).import === done.pressId)).toHaveLength(4);

    // Nothing sent, nothing queued, no link minted, no mail.
    expect(stub.apiCalls().slice(calls)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect(outbox).toEqual([]);
    // What existed is as it was, column by column.
    expect(await db.select().from(family).where(eq(family.id, rivera))).toEqual(before.rivera);
    expect(await db.select().from(family).where(eq(family.id, quiet!.id))).toEqual(before.quiet);
    expect(await db.select().from(parent).where(eq(parent.id, raj.id))).toEqual(before.raj);
    expect(await db.select().from(student).where(eq(student.id, leo))).toEqual(before.leo);
    expect(await linkOf("12", "student")).toEqual(before.leoLink);
    // Off the list now.
    expect((await loadAccountingLinks()).noFamilyList).toEqual([]);
  });

  it("owes a welcome only while welcomes are on, mints no link at the press, and the worker then welcomes with a set-up link", async () => {
    const { tag, linker } = await club({ welcomes: true });
    await seedWorkingMail();
    const r = await review();
    expect(r.welcomes).toBe(true);
    const done = await saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker));
    expect(done.ok && done.message).toContain("2 people are owed a welcome email with a link to set up their sign-in");
    const nita = (await personAt("nita@example.com"))!, ada = (await personAt("ada@example.com"))!;
    expect([nita.welcomeOwed, ada.welcomeOwed, (await personAt("raj@example.com"))!.welcomeOwed]).toEqual([true, true, false]);
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect(outbox).toEqual([]);
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    expect(outbox.map((m) => m.to).sort()).toEqual(["ada@example.com", "nita@example.com"]);
    expect(JSON.stringify(outbox.find((m) => m.to === "nita@example.com"))).toContain("/sign-in/set-up/");
    expect((await linkRows(nita.id)).map((l) => l.purpose)).toEqual(["setup"]);
  });

  it("owes no welcome while welcomes are off, the person left to be welcomed when an Admin switches them on", async () => {
    const { tag, linker } = await club({ welcomes: false });
    const r = await review();
    expect((await saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker))).ok).toBe(true);
    expect((await db.select().from(parent)).some((p) => p.welcomeOwed)).toBe(false);
  });

  it("makes only the families left ticked: one unticked stays listed, and is proposed again", async () => {
    const { tag, linker } = await club();
    const r = await review();
    const done = await saveImport({ customerIds: ["70"], count: 1, stamp: r.stamp }, tag, linkOp(linker));
    expect(done.ok && done.message).toMatch(/^1 family made in the portal and linked to its customer: Patel Family\./);
    expect(await familyOf("80")).toBeNull();
    expect((await loadAccountingLinks()).noFamilyList!.map((c) => c.qboId)).toEqual(["80"]);
    const again = await review();
    expect(again.ids).toEqual(["80"]);
    // Nita, made for the Patels, is reused for the Okafors.
    expect(again.proposal.families[0]!.guardians.find((g) => g.email === "nita@example.com")!.person).toMatchObject({ kind: "existing", name: "Nita Patel" });
  });
});

describe("what the press refuses, making nothing", () => {
  it("refuses a stale stamp, a customer linked or aimed meanwhile, a moved roster tag and malformed arguments", async () => {
    const { tag, linker } = await club();
    const r = await review();
    const before = await madeSoFar();
    const changed = { ok: false, errors: [IMPORT_COPY.changed] };
    const press = (o: Partial<{ customerIds: unknown; count: unknown; stamp: unknown }>, t = tag) => saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp, ...o }, t, linkOp(linker));
    expect(await press({ stamp: `${r.stamp.slice(0, -1)}x` })).toEqual(changed);
    expect(await press({ customerIds: ["70", "90"] })).toEqual(changed); // one not shown
    expect(await press({}, "another-tag")).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    for (const odd of [{ customerIds: [] }, { customerIds: "70" }, { customerIds: ["70", "70"], count: 2 }, { customerIds: ["7O"], count: 1 }, { customerIds: [70], count: 1 },
      { count: 3 }, { count: "2" }, { count: 2.5 }, { stamp: null }, { customerIds: Array.from({ length: IMPORT_MAX + 1 }, (_, n) => String(n + 1)), count: IMPORT_MAX + 1 }]) {
      expect(await press(odd), JSON.stringify(odd)).toEqual({ ok: false, errors: [IMPORT_COPY.notFromPage] });
    }
    // A guardian of an unlinked family signs in with Ada's address: the Okafors are suggested for it, so the list changed.
    const [theirs] = await db.insert(family).values({ name: "The Okafors, saved first", active: true }).returning();
    const ada = await seedParent({ name: "Ada", email: "ada@example.com" });
    await db.insert(guardian).values({ parentId: ada.id, familyId: theirs!.id, status: "invited" });
    expect(await press({})).toEqual(changed);
    const shown = await madeSoFar();
    expect(shown.families).toBe(before.families + 1);
    expect({ ...shown, families: before.families, people: before.people, rows: before.rows }).toEqual(before);
  });

  it("refuses a customer linked meanwhile, and makes one set for two presses at once", async () => {
    const { tag, linker } = await club();
    const r = await review();
    const [first, second] = await Promise.all([saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker)),
      saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker))]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect((first.ok ? second : first)).toEqual({ ok: false, errors: [IMPORT_COPY.changed] });
    expect((await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, "70"), isNotNull(accountingLink.familyId))))).toHaveLength(1);
    expect(await audits("accounting.import.save")).toHaveLength(1);
    expect((await db.select().from(guardian).where(eq(guardian.parentId, (await personAt("nita@example.com"))!.id)))).toHaveLength(2);
  });

  it("refuses the action without the permission that changes families, and checks its arguments", async () => {
    const { tag } = await club();
    const r = await review();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    await expect(saveImportAction(tag, r.stamp, r.ids, 2)).rejects.toBeInstanceOf(AccessDenied);
    expect(await familyOf("70")).toBeNull();
    asStaff(await staffWith("registrar2@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    expect(await saveImportAction(tag, r.stamp, "70" as never, 1)).toEqual({ ok: false, errors: [IMPORT_COPY.notFromPage] });
    expect(await familyOf("70")).toBeNull();
    const done = await saveImportAction(tag, r.stamp, r.ids, 2);
    expect(done).toMatchObject({ ok: true });
    expect(Object.keys(done)).toEqual(["ok", "message"]);
    expect(revalidatedPaths()).toContain("/");
  });
});

describe("the guardian half", () => {
  /** The press, its families' half let through, its guardian half held at its first lock (the settings lock) until `meanwhile` has run. */
  async function pressHeld(tag: string, linker: { id: string; email: string }, meanwhile: () => Promise<void>, w = {}) {
    const r = await review();
    const settings = await hold("settings");
    const press = saveImport({ customerIds: r.ids, count: 2, stamp: r.stamp }, tag, linkOp(linker), w);
    await untilALockIsAwaited(15_000, 1);
    // The families are made and committed by now: the guardian half is the one waiting.
    expect(await familyOf("70")).not.toBeNull();
    await meanwhile();
    await settings.release();
    return press;
  }

  it("keeps the families made when the roster lock is held past the wait, and says each guardian it didn't add", async () => {
    const { tag, linker } = await club();
    let roster: { release: () => Promise<void> } | null = null;
    const done = await pressHeld(tag, linker, async () => { roster = await hold("roster"); }, { rosterWaitMs: 200 });
    await roster!.release();
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.guardians.map((g) => [g.guardian.email, g.result.ok ? "added" : g.result.reason])).toEqual([
      ["ada@example.com", "busy"], ["nita@example.com", "not_tried"], ["nita@example.com", "not_tried"], ["raj@example.com", "not_tried"]]);
    expect(done.message).toContain("Ada Okafor (ada@example.com) wasn't added to Okafor Family: the portal was busy reading QuickBooks for longer than it waits. Add them on the family's page, under Families.");
    expect(done.message).toContain("Raj Patel (raj@example.com) wasn't added to Patel Family: it wasn't tried, as the portal was busy reading QuickBooks.");
    expect(done.message).toContain("No guardian was added.");
    expect(await familyOf("70")).not.toBeNull();
    expect(await familyOf("80")).not.toBeNull();
    expect(await db.select().from(guardian).where(isNotNull(guardian.familyId))).toHaveLength(1); // Raj's Rivera row alone
    expect(await personAt("ada@example.com")).toBeUndefined();
  });

  it("adds no guardian whose address someone else took meanwhile, or whose person was blocked meanwhile, and adds the rest", async () => {
    const { tag, raj, linker } = await club();
    const done = await pressHeld(tag, linker, async () => {
      await seedParent({ name: "Someone else", email: "ada@example.com" });
      await db.update(parent).set({ blocked: true }).where(eq(parent.id, raj.id));
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.guardians.map((g) => [g.guardian.email, g.result.ok ? g.result.person : g.result.reason])).toEqual([
      ["ada@example.com", "taken"], ["nita@example.com", "new"], ["nita@example.com", "made_here"], ["raj@example.com", "blocked"]]);
    expect(done.message).toContain("Ada Okafor (ada@example.com) wasn't added to Okafor Family: someone else in the portal took that address meanwhile.");
    expect(done.message).toContain("Raj Patel (raj@example.com) wasn't added to Patel Family: the person who holds that address was blocked meanwhile.");
    expect(done.message).toContain("2 guardians added, as on a family's page, for 1 new person.");
    const someone = (await personAt("ada@example.com"))!;
    expect(await db.select().from(guardian).where(eq(guardian.parentId, someone.id))).toEqual([]);
    // Ada's Parent customer is left with no guardian, as the family's row on Accounting links shows.
    expect(await linkOf("83", "guardian")).toBeUndefined();
  });
});

describe("a run of IMPORT_MAX", () => {
  it("makes twenty-five families with a guardian each in one press", async () => {
    const tag = await connectRoster(stub);
    for (let n = 0; n < IMPORT_MAX; n++) {
      const id = String(500 + n * 2);
      stub.customers.push(qc(id, `Family ${String(n).padStart(2, "0")}`, "1"), qc(String(501 + n * 2), `Parent ${n}`, "2", { ...under(id), ...mail(`p${n}@example.com`) }));
    }
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    await seedParentSettings({ signin: true });
    const linker = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
    const r = await review();
    expect(r.ids).toHaveLength(IMPORT_MAX);
    const started = Date.now();
    const done = await saveImport({ customerIds: r.ids, count: IMPORT_MAX, stamp: r.stamp }, tag, linkOp(linker));
    console.log(`a press of ${IMPORT_MAX} families with a guardian each took ${Date.now() - started} ms`);
    expect(done.ok).toBe(true);
    expect(await db.select().from(guardian).where(isNotNull(guardian.familyId))).toHaveLength(IMPORT_MAX);
  });
});
