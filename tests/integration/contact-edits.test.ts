import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asParentChoosing, asStaff, fromIp, renderPage, revalidatedPaths } from "../helpers/signed-in";

// A parent's phone and address are read from QuickBooks and written to it: here that is the stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, qboConnection, qboCustomer, rateLimitEvent } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { CONTACT_COPY, loadMyContact } from "@/lib/parents/contact-edits";
import { NOT_THE_FORM, type ContactValues } from "@/lib/parents/contact-fields";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { QUICKBOOKS_WRITE_ACTION } from "@/lib/quickbooks/what-it-does";
import { saveDetailsAction } from "@/app/(parent)/family/details/actions";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import { contactForm, customersOf, inQuickBooks, qbCustomer, seedContactFamilies, shownTo, under } from "../helpers/contact";
import { resetDb, seedStaff } from "../helpers/db";
import { CHENOWETH, RIVERA, connectCompany } from "../helpers/money";
import { seedParentIn, seedSignedInParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, seedShape, stu } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const [R_FAMILY, R_PARENT] = [RIVERA.family.qboId, RIVERA.parent.qboId];
const [C_FAMILY, C_PARENT] = [CHENOWETH.family.qboId, CHENOWETH.parent.qboId];
const SHOWN = shownTo(RIVERA);
const NEW_PHONE = "512-555-0222";
const NEW_ADDRESS = { line1: "7 Kestrel Way", line2: "Unit B", city: "Round Rock", region: "TX", postalCode: "78664", country: "" };
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const calls = () => stub.apiCalls().map((c) => `${c.method} ${c.path.replace(/^\/v3\/company\/\d+/, "")}`);
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0]!;
const copyOf = <T,>(value: T): T => structuredClone(value);
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: null });
const save = (values: ContactValues, version = "0", extra: Record<string, string | Blob> = {}) => saveDetailsAction(contactForm(values, version, extra));

describe("a parent saves their own phone and address to QuickBooks", () => {
  it("layered, with a parent type: the phone goes to the parent's own record, the cache follows, and the save is audited", async () => {
    const { r } = await seedContactFamilies(stub);
    const before = copyOf(stub.customers);
    asParent(r.identity);
    fromIp("203.0.113.77");
    const result = await save({ ...SHOWN, phone: NEW_PHONE });
    expect(result).toEqual({ ok: true, message: CONTACT_COPY.saved, current: { values: { ...SHOWN, phone: NEW_PHONE }, version: "1" } });

    // One read of their own record, then the one write, carrying the version the form was shown and only the phone.
    expect(calls()).toEqual([`GET /customer/${R_PARENT}`, "POST /customer"]);
    expect(JSON.parse(posts()[0]!.body)).toEqual({ Id: R_PARENT, SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    const mine = inQuickBooks(stub, R_PARENT);
    expect(mine).toMatchObject({ DisplayName: RIVERA.parent.name, SyncToken: "1", PrimaryPhone: { FreeFormNumber: NEW_PHONE }, PrimaryEmailAddr: { Address: RIVERA.parent.email }, ParentRef: { value: R_FAMILY } });
    expect(mine.BillAddr).toEqual(before.find((c) => c.Id === R_PARENT)!.BillAddr);
    // Nobody else's record changed: not the family's, not a student's, not the other family's.
    for (const was of before.filter((c) => c.Id !== R_PARENT)) expect(inQuickBooks(stub, was.Id as string)).toEqual(was);

    expect(await cached(R_PARENT)).toMatchObject({ phone: NEW_PHONE, syncToken: "1", email: RIVERA.parent.email, displayName: RIVERA.parent.name });
    expect((await cached(R_PARENT)).qboUpdatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await cached(R_FAMILY)).toMatchObject({ phone: null, syncToken: "0" });
    expect(await cached(C_PARENT)).toMatchObject({ phone: CHENOWETH.parent.phone, syncToken: "0" });

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe(QUICKBOOKS_WRITE_ACTION); // the action the Health page reads for "Last change by a parent"
    expect(log[0]).toMatchObject({ door: "parent", actorId: r.identity.parentId, actorLabel: RIVERA.parent.email, action: "parent.contact.save",
      targetType: "qbo_customer", targetId: R_PARENT, before: { phone: RIVERA.parent.phone }, after: { phone: NEW_PHONE }, ip: "203.0.113.77" });
    // The pages that show these details: the browser's router drops its copies of them.
    expect(revalidatedPaths()).toEqual(["/family/details", "/family", "/"]);

    // The details box shows the new phone.
    const family = await renderPage(FamilyPage);
    expect(family).toContain(`<dt>Phone</dt><dd class="num">${NEW_PHONE}</dd>`);
    expect(family).not.toContain(RIVERA.parent.phone);
  });

  it("the address goes as one billing address, and the audit row holds it before and after", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const result = await save({ phone: SHOWN.phone, ...NEW_ADDRESS });
    expect(result).toEqual({ ok: true, message: CONTACT_COPY.saved, current: { values: { phone: SHOWN.phone, ...NEW_ADDRESS }, version: "1" } });
    expect(JSON.parse(posts()[0]!.body)).toEqual({ Id: R_PARENT, SyncToken: "0", sparse: true,
      BillAddr: { Line1: "7 Kestrel Way", Line2: "Unit B", Line3: "", Line4: "", Line5: "", City: "Round Rock", CountrySubDivisionCode: "TX", PostalCode: "78664", Country: "" } });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: RIVERA.parent.phone },
      BillAddr: { Line1: "7 Kestrel Way", Line2: "Unit B", City: "Round Rock", CountrySubDivisionCode: "TX", PostalCode: "78664" } });
    // The cache keeps no address: only the version moved.
    expect(await cached(R_PARENT)).toMatchObject({ phone: RIVERA.parent.phone, syncToken: "1" });
    const { line1, line2, city, region, postalCode, country } = SHOWN;
    expect((await audits()).map((a) => ({ action: a.action, before: a.before, after: a.after }))).toEqual([
      { action: "parent.contact.save", before: { address: { line1, line2, city, region, postalCode, country } }, after: { address: NEW_ADDRESS } }]);
  });

  it("both at once, and a field emptied is cleared in QuickBooks", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const result = await save({ phone: "", line1: "7 Kestrel Way", line2: "", city: "", region: "", postalCode: "", country: "" });
    expect(result).toMatchObject({ ok: true, current: { values: { phone: "", line1: "7 Kestrel Way", city: "" }, version: "1" } });
    const mine = inQuickBooks(stub, R_PARENT);
    expect(mine.PrimaryPhone).toBeUndefined();
    expect(mine.BillAddr).toEqual({ Line1: "7 Kestrel Way" });
    expect(await cached(R_PARENT)).toMatchObject({ phone: null, syncToken: "1" });
    expect((await audits())[0]).toMatchObject({ before: { phone: RIVERA.parent.phone, address: { line1: "12 Heron Lane" } }, after: { phone: "", address: { line1: "7 Kestrel Way", city: "" } } });
  });

  it("layered, with no parent type: the family's own record is the one changed", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([{ qboId: "7310", displayName: "Noparent Family", typeQboId: "F", email: "home@noparent.example, work@noparent.example", phone: "512-555-0199" }, stu("7311", "Nico Noparent", "7310")]);
    const p = await seedParentIn({ familyQboId: "7310", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "7310" });
    await connectCompany(stub);
    stub.customers = [qbCustomer("7310", "Noparent Family", { PrimaryEmailAddr: { Address: "home@noparent.example, work@noparent.example" }, PrimaryPhone: { FreeFormNumber: "512-555-0199" } }),
      qbCustomer("7311", "Nico Noparent", under("7310"))];
    asParent(p.identity);
    const blank = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
    expect(await loadMyContact(ctxOf(p.identity))).toMatchObject({ state: "ok", me: { edits: "family", name: "Noparent Family" }, form: { values: { phone: "512-555-0199", ...blank }, version: "0" } });
    expect(await save({ phone: NEW_PHONE, ...blank })).toMatchObject({ ok: true, current: { values: { phone: NEW_PHONE }, version: "1" } });
    expect(JSON.parse(posts()[0]!.body)).toEqual({ Id: "7310", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    expect(inQuickBooks(stub, "7310")).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE }, PrimaryEmailAddr: { Address: "home@noparent.example, work@noparent.example" } });
    expect(inQuickBooks(stub, "7311")).toEqual(qbCustomer("7311", "Nico Noparent", under("7310")));
    expect(await cached("7310")).toMatchObject({ phone: NEW_PHONE, syncToken: "1" });
    expect((await audits())[0]).toMatchObject({ action: "parent.contact.save", targetId: "7310", before: { phone: "512-555-0199" }, after: { phone: NEW_PHONE } });
    // The page says whose details these are: every parent of the family shares them.
    const page = await renderPage(FamilyDetailsPage);
    expect(page).toContain("These are your family&#x27;s contact details in the club&#x27;s books. Every parent in your family shares them, so a change here changes them for all of you.");
    expect(page).toContain(`value="${NEW_PHONE}"`);
  });

  it("flat: the member's own record is the one changed", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "7410", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "7420", displayName: "Other Member", typeQboId: "M", email: "other@flat.example", phone: "512-555-0155" }]);
    const m = await seedParentIn({ familyQboId: "7410", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "7410" });
    await connectCompany(stub);
    const other = qbCustomer("7420", "Other Member", { PrimaryPhone: { FreeFormNumber: "512-555-0155" } });
    stub.customers = [qbCustomer("7410", "Marisol Thackeray", { PrimaryPhone: { FreeFormNumber: "512-555-0144" }, BillAddr: { Line1: "3 Wren Row", City: "Austin" } }), copyOf(other)];
    asParent(m.identity);
    expect(await save({ phone: "512-555-0144", line1: "3 Wren Row", line2: "", city: "Pflugerville", region: "TX", postalCode: "", country: "" })).toMatchObject({ ok: true, current: { version: "1" } });
    expect(JSON.parse(posts()[0]!.body)).toMatchObject({ Id: "7410", SyncToken: "0", sparse: true, BillAddr: { Line1: "3 Wren Row", City: "Pflugerville", CountrySubDivisionCode: "TX" } });
    expect(JSON.parse(posts()[0]!.body)).not.toHaveProperty("PrimaryPhone");
    expect(inQuickBooks(stub, "7410")).toMatchObject({ BillAddr: { Line1: "3 Wren Row", City: "Pflugerville", CountrySubDivisionCode: "TX" }, PrimaryPhone: { FreeFormNumber: "512-555-0144" } });
    expect(inQuickBooks(stub, "7420")).toEqual(other);
    expect((await audits())[0]).toMatchObject({ action: "parent.contact.save", targetId: "7410" });
    expect(await renderPage(FamilyDetailsPage)).toContain("These are your family&#x27;s contact details in the club&#x27;s books.");
  });

  it("a sign-in made by hand has no QuickBooks record of its own: nothing is read, nothing is sent", async () => {
    await seedContactFamilies(stub);
    const before = copyOf(stub.customers);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.askTheClub] });
    expect(stub.calls).toHaveLength(0);
    expect(stub.customers).toEqual(before);
    expect((await audits()).map((a) => ({ action: a.action, targetId: a.targetId, after: a.after, actorId: a.actorId }))).toEqual([
      { action: "parent.contact.save.failed", targetId: null, after: { code: "no_record" }, actorId: hand.identity.parentId }]);
    expect(revalidatedPaths()).toEqual([]);
  });

  it("saving what QuickBooks already has changes nothing and writes no audit row", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: `  ${SHOWN.phone} ` })).toEqual({ ok: true, message: CONTACT_COPY.nothingChanged, current: { values: SHOWN, version: "0" } });
    expect(posts()).toHaveLength(0);
    expect(await audits()).toEqual([]);
    expect(inQuickBooks(stub, R_PARENT).SyncToken).toBe("0");
  });

  it("address lines QuickBooks holds past the second are shown on the second, kept by a phone change, and folded in by an address change", async () => {
    const { r } = await seedContactFamilies(stub);
    Object.assign(inQuickBooks(stub, R_PARENT).BillAddr as object, { Line2: "Building 4", Line3: "Rear door", Line5: "Ring twice" });
    asParent(r.identity);
    const shown = { ...SHOWN, line2: "Building 4, Rear door, Ring twice" };
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", form: { values: shown } });
    // A change of phone sends no address: QuickBooks' lines stay as they are.
    expect(await save({ ...shown, phone: NEW_PHONE })).toMatchObject({ ok: true, current: { values: { ...shown, phone: NEW_PHONE }, version: "1" } });
    expect(inQuickBooks(stub, R_PARENT).BillAddr).toMatchObject({ Line2: "Building 4", Line3: "Rear door", Line5: "Ring twice" });
    // A change of address writes what the parent saw and saved, on two lines.
    expect(await save({ ...shown, phone: NEW_PHONE, city: "Buda" }, "1")).toMatchObject({ ok: true, current: { values: { line2: "Building 4, Rear door, Ring twice", city: "Buda" }, version: "2" } });
    expect(inQuickBooks(stub, R_PARENT).BillAddr).toEqual({ Line1: "12 Heron Lane", Line2: "Building 4, Rear door, Ring twice", City: "Buda", CountrySubDivisionCode: "TX", PostalCode: "78745" });
  });
});

describe("a record that changed in QuickBooks while the parent was editing is never overwritten (v1 spec §6.3)", () => {
  it("changed before the save: nothing is sent, and the parent gets the current values to edit again", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // The form was shown version 0. The treasurer then corrects the phone in QuickBooks.
    Object.assign(inQuickBooks(stub, R_PARENT), { PrimaryPhone: { FreeFormNumber: "512-555-0333" }, SyncToken: "1" });
    const theirs = copyOf(inQuickBooks(stub, R_PARENT));
    const result = await save({ ...SHOWN, ...NEW_ADDRESS });
    expect(result).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: { ...SHOWN, phone: "512-555-0333" }, version: "1" } });
    expect(posts()).toHaveLength(0);
    expect(inQuickBooks(stub, R_PARENT)).toEqual(theirs);
    expect(await cached(R_PARENT)).toMatchObject({ phone: RIVERA.parent.phone, syncToken: "0" });
    expect((await audits()).map((a) => ({ action: a.action, targetId: a.targetId, before: a.before, after: a.after }))).toEqual([
      { action: "parent.contact.save.failed", targetId: R_PARENT, before: null, after: { code: "stale" } }]);
    expect(revalidatedPaths()).toEqual([]);
    // Edited again from the current values, with the version they came with, it saves.
    expect(await save({ ...SHOWN, phone: "512-555-0333", ...NEW_ADDRESS }, "1")).toMatchObject({ ok: true, current: { version: "2" } });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0333" }, BillAddr: { Line1: "7 Kestrel Way" } });
  });

  it("changed in the moment between the read and the write: QuickBooks refuses, the record is read again, and nothing is retried", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    stub.beforeUpdate = (customer) => { Object.assign(customer, { PrimaryPhone: { FreeFormNumber: "512-555-0444" }, SyncToken: "1" }); };
    const result = await save({ ...SHOWN, phone: NEW_PHONE });
    expect(result).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: { ...SHOWN, phone: "512-555-0444" }, version: "1" } });
    expect(calls()).toEqual([`GET /customer/${R_PARENT}`, "POST /customer", `GET /customer/${R_PARENT}`]);
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0444" }, SyncToken: "1" });
    expect(await cached(R_PARENT)).toMatchObject({ phone: RIVERA.parent.phone, syncToken: "0" });
    expect((await audits()).map((a) => [a.action, a.after])).toEqual([["parent.contact.save.failed", { code: "stale" }]]);
  });

  it("when the record can't be read again after QuickBooks refuses, the parent is not shown what they typed as if it were current", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // Someone changes the record as the update arrives, and QuickBooks then stops answering.
    stub.beforeUpdate = (customer) => { Object.assign(customer, { PrimaryPhone: { FreeFormNumber: "512-555-0444" }, SyncToken: "1" }); stub.failNext = 5; };
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.changedUnseen] });
    expect(posts()).toHaveLength(1);
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0444" }, SyncToken: "1" });
    expect((await audits()).map((a) => [a.action, a.after])).toEqual([["parent.contact.save.failed", { code: "stale" }]]);
  });

  it("a version that was never this record's is a stale one", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE }, "7")).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: SHOWN, version: "0" } });
    expect(posts()).toHaveLength(0);
  });
});

describe("when QuickBooks can't be reached or refuses, nothing is changed and the save is audited with its code", () => {
  const failure = async () => {
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "parent.contact.save.failed", door: "parent", before: null });
    expect(JSON.stringify(log)).not.toMatch(/must never store/);
    return (log[0]!.after as { code: string }).code;
  };
  const unchanged = async () => {
    expect(stub.customers).toEqual([...customersOf(RIVERA), ...customersOf(CHENOWETH)]);
    expect(await cached(R_PARENT)).toMatchObject({ phone: RIVERA.parent.phone, syncToken: "0" });
    expect(revalidatedPaths()).toEqual([]);
  };

  it("QuickBooks is not connected", async () => {
    const r = await seedSignedInParent(RIVERA);
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect(await failure()).toBe("not_connected");
    expect(stub.calls).toHaveLength(0);
  });

  it("only an Admin can fix the connection: refused at once, and Intuit is not asked", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)", lastErrorAt: new Date() });
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect(await failure()).toBe("needs_admin");
    expect(stub.calls).toHaveLength(0);
    await unchanged();
  });

  it("QuickBooks can't be reached", async () => {
    const { r } = await seedContactFamilies(stub);
    stub.dropApi = true;
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect(await failure()).toBe("unreachable");
    expect(posts()).toHaveLength(0);
    await unchanged();
  });

  it("QuickBooks keeps failing", async () => {
    const { r } = await seedContactFamilies(stub);
    stub.failNext = 5;
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect(await failure()).toBe("http_500");
    expect(calls()).toEqual([`GET /customer/${R_PARENT}`, `GET /customer/${R_PARENT}`]); // the read is tried twice, and the write not at all
    await unchanged();
  });

  it("the connection is being renewed by someone else: the save doesn't wait in line for it, and nothing is sent", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.update(qboConnection).set({ accessExpiresAt: new Date(Date.now() - 1000) }); // the token must be refreshed first
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    let holder!: Promise<void>;
    const locked = new Promise<void>((done) => { holder = db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); done(); await held; }); });
    await locked;
    asParent(r.identity);
    try {
      const started = Date.now();
      expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { release(); await holder; }
    expect(await failure()).toBe("busy");
    expect(stub.calls).toHaveLength(0);
    await unchanged();
  });

  it.each([["6000"], ["2050"]])("QuickBooks won't take a value (Fault %s): the parent is asked to check it", async (code) => {
    const { r } = await seedContactFamilies(stub);
    stub.updateFault = code;
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.notAccepted] });
    expect(await failure()).toBe(`fault_${code}`);
    expect(posts()).toHaveLength(1);
    await unchanged();
  });

  it("QuickBooks refuses for another reason (a duplicate name's Fault 6240): its code is kept, its words are not", async () => {
    const { r } = await seedContactFamilies(stub);
    stub.updateFault = "6240";
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect(await failure()).toBe("fault_6240");
    await unchanged();
  });

  it("the answer to the write never arrives: the parent is told the portal can't tell, and the page then shows what QuickBooks has", async () => {
    const { r } = await seedContactFamilies(stub);
    stub.loseUpdateAnswer = true;
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.unsure] });
    expect(await failure()).toBe("unreachable");
    expect(posts()).toHaveLength(1); // not sent again
    expect(await cached(R_PARENT)).toMatchObject({ phone: RIVERA.parent.phone, syncToken: "0" });
    stub.loseUpdateAnswer = false;
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", form: { values: { phone: NEW_PHONE }, version: "1" } });
  });

  it("the record was moved to another family, or made inactive, in QuickBooks since the roster was read: it is not theirs to change", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    Object.assign(inQuickBooks(stub, R_PARENT), { ParentRef: { value: C_FAMILY } });
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    Object.assign(inQuickBooks(stub, R_PARENT), { ParentRef: { value: R_FAMILY }, Active: false });
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.tryLater] });
    expect((await audits()).map((a) => (a.after as { code: string }).code)).toEqual(["moved", "inactive"]);
    expect(posts()).toHaveLength(0);
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "unavailable" });
  });
});

describe("what the browser sends is checked, and how often", () => {
  const long = (n: number) => "x".repeat(n);
  const control = (code: number) => `12${String.fromCodePoint(code)}34`;

  it.each([
    ["a phone of 31 characters", { phone: long(31) }, ["Phone can be up to 30 characters. Please shorten it."]],
    ["an address line of 201 characters", { line1: long(201) }, ["Address line 1 can be up to 200 characters. Please shorten it."]],
    ["a postal code of 21 characters and a city of 101", { postalCode: long(21), city: long(101) }, ["City can be up to 100 characters. Please shorten it.", "ZIP or postal code can be up to 20 characters. Please shorten it."]],
    ["a control character", { phone: control(7) }, ["Phone has a character that can't be saved. Please type it again."]],
    ["a line break inside a field", { line2: "Unit B\nRing twice" }, ["Address line 2 has a character that can't be saved. Please type it again."]],
    ["a character that reorders the text", { city: control(0x202e) }, ["City has a character that can't be saved. Please type it again."]],
    ["a field far too long to be a form's", { country: long(5000) }, [NOT_THE_FORM]],
  ] as [string, Partial<ContactValues>, string[]][])("refuses %s, and asks nothing of QuickBooks", async (_what, bad, errors) => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, ...bad })).toEqual({ ok: false, errors });
    expect(stub.calls).toHaveLength(0);
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual([["parent.contact.save.failed", null, { code: "invalid" }]]);
  });

  it("refuses anything that isn't the form: a file for a field, a version that isn't one, a missing field, something that isn't a form at all", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const without = contactForm(SHOWN, "0"); without.delete("city");
    const twice = contactForm(SHOWN, "0"); twice.append("phone", NEW_PHONE);
    const attempts: unknown[] = [
      contactForm(SHOWN, "0", { phone: new Blob(["512-555-0222"]) }), contactForm(SHOWN, ""), contactForm(SHOWN, "0 or 1=1"), contactForm(SHOWN, "1e3"), without,
      { ...SHOWN, phone: NEW_PHONE, version: "0" }, null, "phone=512-555-0222", [contactForm(SHOWN, "0")],
    ];
    for (const attempt of attempts) {
      await db.delete(rateLimitEvent);
      expect(await saveDetailsAction(attempt as FormData)).toEqual({ ok: false, errors: [NOT_THE_FORM] });
    }
    // A field sent twice is read once, as a browser's form reads it: the first value.
    await db.delete(rateLimitEvent);
    expect(await saveDetailsAction(twice)).toMatchObject({ ok: true, message: CONTACT_COPY.nothingChanged });
    expect(posts()).toHaveLength(0);
    expect(stub.customers).toEqual([...customersOf(RIVERA), ...customersOf(CHENOWETH)]);
  });

  it("markup is text: it is saved as it was typed, and shown as text wherever it is shown", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const phone = "<img src=x onerror=alert(1)>", line1 = `<script>alert("x")</script>`, city = `"><svg onload=alert(2)>`;
    expect(await save({ ...SHOWN, phone, line1, city })).toMatchObject({ ok: true, current: { values: { phone, line1, city } } });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: phone }, BillAddr: { Line1: line1, City: city } });
    expect(await cached(R_PARENT)).toMatchObject({ phone });
    expect((await audits())[0]).toMatchObject({ after: { phone, address: { line1, city } } });
    for (const html of [await renderPage(FamilyPage), await renderPage(FamilyDetailsPage)]) {
      expect(html).not.toMatch(/<img\b|<script>alert|<svg onload/); // React adds one script of its own for the form: not these
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
    const page = await renderPage(FamilyDetailsPage);
    expect(page).toContain(`value="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"`);
    expect(page).toContain(`value="&quot;&gt;&lt;svg onload=alert(2)&gt;"`);
  });

  it("lets a parent save a handful of times an hour, then refuses without asking QuickBooks, and audits the first refusal only", async () => {
    const { r, c } = await seedContactFamilies(stub);
    asParent(r.identity);
    const max = RATE_LIMITS.contact_save_parent.max;
    expect(max).toBeLessThanOrEqual(10);
    for (let i = 0; i < max; i++) expect(await save({ ...SHOWN, phone: `512-555-03${10 + i}` }, String(i))).toMatchObject({ ok: true });
    const asked = stub.apiCalls().length;
    for (let i = 0; i < 3; i++) expect(await save({ ...SHOWN, phone: "512-555-0399" }, String(max))).toEqual({ ok: false, errors: [CONTACT_COPY.tooMany] });
    expect(stub.apiCalls()).toHaveLength(asked);
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: `512-555-03${10 + max - 1}` }, SyncToken: String(max) });
    const log = await audits();
    expect(log.map((a) => a.action)).toEqual([...Array.from({ length: max }, () => "parent.contact.save"), "parent.contact.save.failed"]);
    expect(log.at(-1)).toMatchObject({ after: { code: "rate_limited" }, actorId: r.identity.parentId });
    // Counted per person: the other family's parent is not held up.
    asParent(c.identity);
    expect(await save({ ...shownTo(CHENOWETH), phone: NEW_PHONE })).toMatchObject({ ok: true });
  });
});

describe("the family comes from the session and nothing else (v1 spec §12)", () => {
  it("as family A with family B's customer id in every argument: nothing of B is read, changed or returned", async () => {
    const { r, c } = await seedContactFamilies(stub);
    const theirs = copyOf(customersOf(CHENOWETH));
    const theirRows = await db.select().from(qboCustomer).where(eq(qboCustomer.parentQboId, C_FAMILY));
    asParent(r.identity);
    // Every name a form could give an id, each naming B's parent or B's family.
    const naming = (id: string) => Object.fromEntries(["id", "Id", "ID", "qboId", "customerId", "customer", "recordId", "sourceQboId", "familyQboId", "family", "parentQboId", "guardianId", "realmId"].map((name) => [name, id]));
    const nothingOfTheirs = async (result: unknown) => {
      for (const call of stub.apiCalls()) {
        expect(`${call.path}?${call.query.toString()}`).not.toMatch(new RegExp(`${C_PARENT}|${C_FAMILY}`));
        if (call.method === "GET") expect(call.path).toMatch(new RegExp(`/customer/${R_PARENT}$`));
        else expect((JSON.parse(call.body) as { Id: string }).Id).toBe(R_PARENT);
      }
      for (const was of theirs) expect(inQuickBooks(stub, was.Id as string)).toEqual(was);
      expect(await db.select().from(qboCustomer).where(eq(qboCustomer.parentQboId, C_FAMILY))).toEqual(theirRows);
      for (const row of await audits()) expect([null, R_PARENT]).toContain(row.targetId);
      for (const marker of c.markers) expect(JSON.stringify(result), marker).not.toContain(marker);
    };

    // B's ids beside a good form: the save goes to A's own record.
    const saved = await save({ ...SHOWN, phone: NEW_PHONE }, "0", { ...naming(C_PARENT), Customer: C_FAMILY });
    expect(saved).toMatchObject({ ok: true, current: { version: "1" } });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    await nothingOfTheirs(saved);

    // B's id where the version goes: it is only ever a version, and not this record's.
    const asVersion = await save({ ...SHOWN, phone: "512-555-0223" }, C_PARENT, naming(C_FAMILY));
    expect(asVersion).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: { ...SHOWN, phone: NEW_PHONE }, version: "1" } });
    await nothingOfTheirs(asVersion);

    // B's id as a value is a value: it lands in A's own record as text, and B's record is as it was.
    const asValue = await save({ ...SHOWN, phone: C_PARENT, line1: C_FAMILY }, "1");
    expect(asValue).toMatchObject({ ok: true, current: { values: { phone: C_PARENT, line1: C_FAMILY }, version: "2" } });
    expect(inQuickBooks(stub, R_PARENT)).toMatchObject({ PrimaryPhone: { FreeFormNumber: C_PARENT }, BillAddr: { Line1: C_FAMILY } });
    for (const was of theirs) expect(inQuickBooks(stub, was.Id as string)).toEqual(was);
    expect(await db.select().from(qboCustomer).where(eq(qboCustomer.parentQboId, C_FAMILY))).toEqual(theirRows);
    expect(posts().map((p) => (JSON.parse(p.body) as { Id: string }).Id)).toEqual([R_PARENT, R_PARENT]);
  });

  it("a link that names another family's record, or a student's, gives nothing to change", async () => {
    const { r } = await seedContactFamilies(stub);
    const before = copyOf(stub.customers);
    asParent(r.identity);
    for (const source of [C_PARENT, C_FAMILY, RIVERA.students[0]!.qboId, R_FAMILY, "999999"]) {
      await db.update(guardian).set({ sourceQboId: source }).where(eq(guardian.id, r.identity.guardianId));
      await db.delete(rateLimitEvent);
      expect(await save({ ...SHOWN, phone: NEW_PHONE }), source).toEqual({ ok: false, errors: [CONTACT_COPY.askTheClub] });
      expect(await loadMyContact(ctxOf(r.identity)), source).toEqual({ state: "none" });
    }
    expect(stub.calls).toHaveLength(0);
    expect(stub.customers).toEqual(before);
  });

  it("refuses anyone who is not a signed-in parent with a family chosen, the same way whatever the reason", async () => {
    const { r } = await seedContactFamilies(stub);
    const form = () => contactForm({ ...SHOWN, phone: NEW_PHONE }, "0");
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    asParentChoosing(r.identity);
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    asStaff(await seedStaff({ email: "admin@example.org", admin: true }));
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    expect(stub.calls).toHaveLength(0);
    expect(stub.customers).toEqual([...customersOf(RIVERA), ...customersOf(CHENOWETH)]);
    expect(await audits()).toEqual([]);
  });
});
