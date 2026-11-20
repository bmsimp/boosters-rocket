import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

/**
 * A parent with a live, unconfirmed request to change their sign-in address, whose QuickBooks record's email field now
 * reads as that change. Two ways come to the same field, and nothing tells them apart:
 *  (c) QuickBooks took the parent's own change, the portal's side failed, and a roster read put the new address in the
 *      cache: the link still finishes the change (loadMyRecordForMyEmailChange(), src/lib/parents/my-family.ts);
 *  (d) the club gave the record to another person at that same address, name and phone and all.
 * Whether a parent may change their sign-in email goes by their sign-in address alone (loadMyRecord()): in both, the
 * pages offer no change of it. What a parent is shown as their own details is the portal's own (loadMyFamily()'s `me`,
 * stage 3's slice 11a): their name, their sign-in address and the phone the portal holds, nothing of the record, and a
 * save changes the portal's own details only, never the record.
 */
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, qboCustomer } from "@/lib/db/schema";
import { loadMyContact } from "@/lib/parents/contact-edits";
import { canChangeMyEmail, confirmMyEmailChange, findMyEmailChange } from "@/lib/parents/email-change";
import { loadMyFamily, loadMyRecord } from "@/lib/parents/my-family";
import { saveDetailsAction } from "@/app/(parent)/family/details/actions";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import { syncAppRecords } from "../helpers/app-records";
import { contactForm, inQuickBooks, seedContactFamilies, shownTo } from "../helpers/contact";
import { resetDb } from "../helpers/db";
import { seedEmailChange } from "../helpers/email-change";
import { RIVERA } from "../helpers/money";
import type { SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const R_PARENT = RIVERA.parent.qboId;
const OLD = RIVERA.parent.email, NEW = "quinn.someone@family-r.example";
/** The person the club gave the record to in (d), at the address the parent asked to move to. */
const Q = { name: "Quinn Someone", phone: "737-555-0142" };
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const customerReads = () => stub.apiCalls().filter((c) => c.method === "GET" && /\/customer\/\d+$/.test(c.path));
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));

let r: SeededParent;
let token: string;
const ctx = () => ({ ...r.identity, ip: null });

/** The record as QuickBooks holds it now, and as a roster read put it in the cache. */
async function recordReads(o: { name?: string; phone?: string }) {
  Object.assign(inQuickBooks(stub, R_PARENT), { PrimaryEmailAddr: { Address: NEW }, SyncToken: "1",
    ...(o.name ? { DisplayName: o.name } : {}), ...(o.phone ? { PrimaryPhone: { FreeFormNumber: o.phone } } : {}) });
  await db.update(qboCustomer).set({ email: NEW, ...(o.name ? { displayName: o.name } : {}), ...(o.phone ? { phone: o.phone } : {}) })
    .where(eq(qboCustomer.qboId, R_PARENT));
  await syncAppRecords();
}

/** The parent's own name and sign-in address, and the portal's own details: no change of the sign-in email, and nothing of the record. */
function showsOnlyTheirOwn(html: string) {
  expect(html).toContain(`<dt>Name</dt><dd>${r.identity.name}</dd><dt>Email</dt><dd>${OLD}</dd>`);
  expect(html).not.toMatch(/href="\/family\/email"|Change my sign-in email/);
  expect(html).not.toContain(NEW);
}

describe("a record whose email field reads as the parent's own unconfirmed change", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    ({ r } = await seedContactFamilies(stub));
    ({ token } = await seedEmailChange({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyId: r.identity.familyId,
      recordQboId: R_PARENT, newEmail: NEW }));
  });

  it("given to another person by the club, shows the parent nothing of that person and offers no edit", async () => {
    await recordReads(Q);
    // What the pages are given to show: the portal's own details, and no record of theirs, so nothing of the record reaches a component.
    expect((await loadMyFamily(ctx()))?.me).toEqual({ name: r.identity.name, email: OLD, phone: RIVERA.parent.phone, edits: "own" });
    expect(await loadMyRecord(ctx())).toBeNull();
    expect(await loadMyContact(ctx())).toMatchObject({ state: "ok", form: { values: { phone: RIVERA.parent.phone }, version: "p:0" } });
    expect(await canChangeMyEmail(ctx())).toBe(false);
    asParent(r.identity);
    for (const page of [FamilyPage, FamilyDetailsPage]) {
      const html = await renderPage(page);
      showsOnlyTheirOwn(html);
      expect(html).not.toContain(Q.name);
      expect(html).not.toContain(Q.phone);
    }
    // Neither page read the record from QuickBooks.
    expect(customerReads()).toEqual([]);
  });

  it("given to another person by the club, a save changes the portal's own details and nothing of the record", async () => {
    await recordReads(Q);
    asParent(r.identity);
    const result = await saveDetailsAction(contactForm({ ...shownTo(RIVERA), line1: "", city: "", region: "", postalCode: "", phone: "512-555-0999" }, "p:0"));
    expect(result).toMatchObject({ ok: true, current: { values: { phone: "512-555-0999" }, version: "p:1" } });
    expect((await db.select({ phone: parent.phone }).from(parent).where(eq(parent.id, r.identity.parentId)))[0]!.phone).toBe("512-555-0999");
    // Nothing was asked of QuickBooks, and nothing changed there or in the cache.
    expect(stub.apiCalls().filter((c) => c.path.includes("/customer"))).toEqual([]);
    expect(posts()).toEqual([]);
    expect(inQuickBooks(stub, R_PARENT).PrimaryPhone).toEqual({ FreeFormNumber: Q.phone });
    expect((await db.select({ phone: qboCustomer.phone }).from(qboCustomer).where(eq(qboCustomer.qboId, R_PARENT)))[0]!.phone).toBe(Q.phone);
    expect((await audits()).filter((a) => a.action === "parent.details.save").map((a) => [a.targetType, a.targetId])).toEqual([["parent", r.identity.parentId]]);
    expect((await audits()).filter((a) => a.action === "parent.contact.save")).toEqual([]);
  });

  it("made by QuickBooks taking the parent's change, shows their own name and address until the live link finishes it", async () => {
    await recordReads({});
    expect((await loadMyFamily(ctx()))?.me).toMatchObject({ email: OLD, edits: "own" });
    expect(await loadMyContact(ctx())).toMatchObject({ state: "ok" });
    asParent(r.identity);
    showsOnlyTheirOwn(await renderPage(FamilyPage));
    // The link mailed to the new address still asks, and confirming finishes the portal's side, sending nothing.
    expect(await findMyEmailChange(ctx(), token)).toEqual({ state: "ask", newEmail: NEW });
    expect(await confirmMyEmailChange(ctx(), token)).toMatchObject({ ok: true, signedOut: true });
    expect(posts()).toEqual([]);
    expect((await db.select({ email: parent.email }).from(parent).where(eq(parent.id, r.identity.parentId)))[0]!.email).toBe(NEW);
    expect((await audits()).filter((a) => a.action === "parent.email.save").map((a) => (a.after as { app?: string }).app)).toEqual(["changed"]);
  });
});
