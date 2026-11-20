import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asParentChoosing, asStaff, fromIp, renderPage, revalidatedPaths } from "../helpers/signed-in";

// A parent's phone and address are the portal's own (stage 3's slice 11a): nothing here is sent to QuickBooks. The stub
// is connected anyway, so a request that was sent would be seen (stub.apiCalls()), never reach Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, parent, parentAuthSession, qboCustomer, rateLimitEvent } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { CONTACT_COPY, loadMyContact } from "@/lib/parents/contact-edits";
import { loadMyFamily } from "@/lib/parents/my-family";
import { NOT_THE_FORM, type ContactValues } from "@/lib/parents/contact-fields";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { saveDetailsAction } from "@/app/(parent)/family/details/actions";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import { NO_DETAILS, contactForm, familyDetails, personDetails, seedContactFamilies, setFamilyDetails, setPersonDetails } from "../helpers/contact";
import { resetDb, seedGuardian, seedStaff } from "../helpers/db";
import { RIVERA } from "../helpers/money";
import { identityNow, seedParentIn, seedTwoFamilies } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, par, stu, storeShape } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const R_FAMILY = RIVERA.family.qboId;
const NEW_PHONE = "512-555-0222";
const NEW_ADDRESS = { line1: "7 Kestrel Way", line2: "Unit B", city: "Round Rock", region: "TX", postalCode: "78664", country: "" };
/** What the form shows Rivera's parent before anything is changed: the phone on their person row, and no address. */
const SHOWN: ContactValues = { ...NO_DETAILS, phone: RIVERA.parent.phone };
const NO_PARENT_TYPE = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null } as const;
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: null });
const save = (values: ContactValues, version = "p:0", extra: Record<string, string | Blob> = {}) => saveDetailsAction(contactForm(values, version, extra));
/** Nothing at all was asked of QuickBooks, and nothing of the roster cache changed. */
async function nothingSentOrCached(cacheBefore: unknown) {
  expect(stub.apiCalls()).toEqual([]);
  expect(await db.select().from(qboCustomer).orderBy(asc(qboCustomer.qboId))).toEqual(cacheBefore);
  expect(await rosterRefreshAsked()).toBe(false);
}
const cacheNow = () => db.select().from(qboCustomer).orderBy(asc(qboCustomer.qboId));

describe("a parent saves their phone and address in the portal", () => {
  it("layered, with a parent type: the phone is saved on the person, audited, and nothing is sent to QuickBooks", async () => {
    const { r } = await seedContactFamilies(stub);
    const cacheBefore = await cacheNow();
    asParent(r.identity);
    fromIp("203.0.113.77");
    expect(await loadMyContact(ctxOf(r.identity))).toEqual({ state: "ok",
      me: { name: RIVERA.parent.name, email: RIVERA.parent.email, phone: RIVERA.parent.phone, edits: "own" }, form: { values: SHOWN, version: "p:0" } });
    const result = await save({ ...SHOWN, phone: NEW_PHONE });
    expect(result).toEqual({ ok: true, message: CONTACT_COPY.saved, current: { values: { ...SHOWN, phone: NEW_PHONE }, version: "p:1" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { ...SHOWN, phone: NEW_PHONE }, version: 1 });
    // The family's own details, for books with no parent type, are not touched.
    expect(await familyDetails(r.identity.familyId)).toEqual({ values: NO_DETAILS, version: 0 });
    await nothingSentOrCached(cacheBefore);

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ door: "parent", actorId: r.identity.parentId, actorLabel: RIVERA.parent.email, action: "parent.details.save",
      targetType: "parent", targetId: r.identity.parentId, before: { phone: RIVERA.parent.phone }, after: { phone: NEW_PHONE }, ip: "203.0.113.77" });
    // The pages that show these details: the browser's router drops its copies of them.
    expect(revalidatedPaths()).toEqual(["/family/details", "/family", "/"]);
    const page = await renderPage(FamilyPage);
    expect(page).toContain(`<dt>Phone</dt><dd class="num">${NEW_PHONE}</dd>`);
    expect(page).not.toContain(RIVERA.parent.phone);
  });

  it("the address is saved as one, and the audit row holds it before and after", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ phone: SHOWN.phone, ...NEW_ADDRESS })).toEqual({ ok: true, message: CONTACT_COPY.saved, current: { values: { phone: SHOWN.phone, ...NEW_ADDRESS }, version: "p:1" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { phone: SHOWN.phone, ...NEW_ADDRESS }, version: 1 });
    const [row] = await db.select().from(parent).where(eq(parent.id, r.identity.parentId));
    expect(row).toMatchObject({ addressLine1: "7 Kestrel Way", addressLine2: "Unit B", addressCountry: null }); // an empty field is stored as null
    const none = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
    expect((await audits()).map((a) => ({ action: a.action, before: a.before, after: a.after }))).toEqual([
      { action: "parent.details.save", before: { address: none }, after: { address: NEW_ADDRESS } }]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("both at once, and a field emptied is cleared", async () => {
    const { r } = await seedContactFamilies(stub);
    await setPersonDetails(r.identity.parentId, NEW_ADDRESS, 3);
    asParent(r.identity);
    const result = await save({ ...NO_DETAILS, line1: "9 Plover Place" }, "p:3");
    expect(result).toMatchObject({ ok: true, current: { values: { phone: "", line1: "9 Plover Place", city: "" }, version: "p:4" } });
    const [row] = await db.select().from(parent).where(eq(parent.id, r.identity.parentId));
    expect(row).toMatchObject({ phone: null, addressLine1: "9 Plover Place", addressCity: null, contactVersion: 4 });
    expect((await audits())[0]).toMatchObject({ before: { phone: RIVERA.parent.phone, address: { line1: "7 Kestrel Way" } }, after: { phone: "", address: { line1: "9 Plover Place", city: "" } } });
  });

  it("saving what the portal already has changes nothing and writes no audit row", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: `  ${SHOWN.phone} ` })).toEqual({ ok: true, message: CONTACT_COPY.nothingChanged, current: { values: SHOWN, version: "p:0" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: SHOWN, version: 0 });
    expect(await audits()).toEqual([]);
  });

  it("a guardian staff added, with no QuickBooks record of their own, sees and changes their own details", async () => {
    await seedContactFamilies(stub);
    const added = await seedParentIn({ familyQboId: R_FAMILY, name: "Hollis Handmade", email: "hollis.handmade@family-r.example" });
    asParent(added.identity);
    expect(await loadMyContact(ctxOf(added.identity))).toMatchObject({ state: "ok", me: { name: "Hollis Handmade", edits: "own" }, form: { values: NO_DETAILS, version: "p:0" } });
    const page = await renderPage(FamilyDetailsPage);
    expect(page).toContain("<form");
    expect(page).toContain("These are the details the club uses to reach you.");
    expect(await save({ ...NO_DETAILS, phone: NEW_PHONE, ...NEW_ADDRESS })).toMatchObject({ ok: true, current: { version: "p:1" } });
    expect(await personDetails(added.identity.parentId)).toEqual({ values: { phone: NEW_PHONE, ...NEW_ADDRESS }, version: 1 });
    // The family's own parent keeps theirs.
    const [rivera] = await db.select().from(parent).where(eq(parent.email, RIVERA.parent.email));
    expect(await personDetails(rivera!.id)).toEqual({ values: SHOWN, version: 0 });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a person in two families sees and changes one set of details, from either", async () => {
    const { r } = await seedContactFamilies(stub);
    await addToCache([fam("7210", "Cedarholm Family"), par("7211", RIVERA.parent.name, "7210", RIVERA.parent.email), stu("7212", "Cosima Cedarholm", "7210")]);
    await seedGuardian({ parentId: r.identity.parentId, familyQboId: "7210", status: "active", sourceQboId: "7211" });
    await syncAppRecords();
    const inRivera = await identityNow(r.session.id);
    expect(inRivera.families).toHaveLength(2);
    asParent(inRivera);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toMatchObject({ ok: true, current: { version: "p:1" } });
    // The same person, viewing the other family: the same details, at the version the save left them.
    await db.update(parentAuthSession).set({ familyId: await recordOfCustomer("7210", "family") }).where(eq(parentAuthSession.id, r.session.id));
    const inCedar = await identityNow(r.session.id);
    expect(String(inCedar.familyId)).not.toBe(String(inRivera.familyId));
    expect(await loadMyContact(ctxOf(inCedar))).toMatchObject({ state: "ok", form: { values: { phone: NEW_PHONE }, version: "p:1" } });
    expect((await loadMyFamily(ctxOf(inCedar)))!.me).toEqual({ name: RIVERA.parent.name, email: RIVERA.parent.email, phone: NEW_PHONE, edits: "own" });
    asParent(inCedar);
    expect(await save({ ...SHOWN, phone: NEW_PHONE, ...NEW_ADDRESS }, "p:1")).toMatchObject({ ok: true, current: { version: "p:2" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { phone: NEW_PHONE, ...NEW_ADDRESS }, version: 2 });
    for (const familyId of [inRivera.familyId, inCedar.familyId]) expect(await familyDetails(familyId)).toEqual({ values: NO_DETAILS, version: 0 });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("layered with no parent type: the details are the family's, shared by its guardians, and never shown to another family", async () => {
    const { r, c } = await seedContactFamilies(stub);
    await storeShape(NO_PARENT_TYPE);
    const second = await seedParentIn({ familyQboId: R_FAMILY, name: "Remy Riverquill", email: "remy.riverquill@family-r.example", phone: "512-555-0111" });
    await setFamilyDetails(c.identity.familyId, { phone: "737-555-0999", line1: "48 Cormorant Court", city: "Cedar Park" }, 2);
    asParent(r.identity);
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", me: { name: RIVERA.parent.name, edits: "family", phone: null }, form: { values: NO_DETAILS, version: "f:0" } });
    let page = await renderPage(FamilyDetailsPage);
    expect(page).toContain("These are the details the club uses to reach your family. Every parent in your family shares them, so a change here changes them for all of you.");
    for (const theirs of ["737-555-0999", "48 Cormorant Court", "Cedar Park"]) expect(page, theirs).not.toContain(theirs);
    expect(await save({ ...NO_DETAILS, phone: NEW_PHONE, ...NEW_ADDRESS }, "f:0")).toEqual({ ok: true, message: CONTACT_COPY.savedFamily,
      current: { values: { phone: NEW_PHONE, ...NEW_ADDRESS }, version: "f:1" } });
    expect(await familyDetails(r.identity.familyId)).toEqual({ values: { phone: NEW_PHONE, ...NEW_ADDRESS }, version: 1 });
    // The person's own row keeps its phone; the other family's details are as they were.
    expect(await personDetails(r.identity.parentId)).toEqual({ values: SHOWN, version: 0 });
    expect(await familyDetails(c.identity.familyId)).toEqual({ values: { ...NO_DETAILS, phone: "737-555-0999", line1: "48 Cormorant Court", city: "Cedar Park" }, version: 2 });
    expect((await audits()).map((a) => [a.action, a.targetType, a.targetId])).toEqual([["parent.details.save", "family", String(r.identity.familyId)]]);
    // The family's other guardian reads what was saved, and a save from them with the old version is held back.
    asParent(second.identity);
    page = await renderPage(FamilyDetailsPage);
    expect(page).toContain(`value="${NEW_PHONE}"`);
    expect(page).not.toContain("512-555-0111");
    expect(await save({ ...NO_DETAILS, phone: "512-555-0333" }, "f:0")).toEqual({ ok: false, errors: [CONTACT_COPY.changed],
      current: { values: { phone: NEW_PHONE, ...NEW_ADDRESS }, version: "f:1" } });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("flat: the member's details are the family's own record's", async () => {
    await seedContactFamilies(stub);
    await storeShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "7410", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "7420", displayName: "Other Member", typeQboId: "M", email: "other@flat.example", phone: "512-555-0155" }]);
    const m = await seedParentIn({ familyQboId: "7410", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "7410" });
    const other = await seedParentIn({ familyQboId: "7420", name: "Other Member", email: "other@flat.example", sourceQboId: "7420" });
    await setFamilyDetails(other.identity.familyId, { phone: "512-555-0155", line1: "1 Elsewhere Row" });
    asParent(m.identity);
    expect(await save({ ...NO_DETAILS, line1: "3 Wren Row", city: "Pflugerville", region: "TX" }, "f:0")).toMatchObject({ ok: true, message: CONTACT_COPY.savedFamily, current: { version: "f:1" } });
    expect(await familyDetails(m.identity.familyId)).toEqual({ values: { ...NO_DETAILS, line1: "3 Wren Row", city: "Pflugerville", region: "TX" }, version: 1 });
    expect(await familyDetails(other.identity.familyId)).toEqual({ values: { ...NO_DETAILS, phone: "512-555-0155", line1: "1 Elsewhere Row" }, version: 0 });
    const page = await renderPage(FamilyDetailsPage);
    expect(page).toContain("These are the details the club uses to reach your family.");
    expect(page).not.toContain("1 Elsewhere Row");
    expect((await audits())[0]).toMatchObject({ action: "parent.details.save", targetType: "family", targetId: String(m.identity.familyId) });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("markup is text: it is saved as it was typed, and shown as text wherever it is shown", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const phone = "<img src=x onerror=alert(1)>", line1 = `<script>alert("x")</script>`, city = `"><svg onload=alert(2)>`;
    expect(await save({ ...SHOWN, phone, line1, city })).toMatchObject({ ok: true, current: { values: { phone, line1, city } } });
    expect((await audits())[0]).toMatchObject({ after: { phone, address: { line1, city } } });
    for (const html of [await renderPage(FamilyPage), await renderPage(FamilyDetailsPage)]) {
      expect(html).not.toMatch(/<img\b|<script>alert|<svg onload/); // React adds one script of its own for the form: not these
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
    const page = await renderPage(FamilyDetailsPage);
    expect(page).toContain(`value="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"`);
    expect(page).toContain(`value="&quot;&gt;&lt;svg onload=alert(2)&gt;"`);
  });
});

describe("details saved while the parent was editing are never overwritten (v1 spec §6.3)", () => {
  it("a version that is not the row's: nothing is saved, and the parent gets the current values to edit again", async () => {
    const { r } = await seedContactFamilies(stub);
    // The form was shown version 0; the details were then saved from another device.
    await setPersonDetails(r.identity.parentId, { phone: "512-555-0333" }, 1);
    asParent(r.identity);
    const result = await save({ ...SHOWN, ...NEW_ADDRESS });
    expect(result).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: { ...SHOWN, phone: "512-555-0333" }, version: "p:1" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { ...SHOWN, phone: "512-555-0333" }, version: 1 });
    expect((await audits()).map((a) => ({ action: a.action, targetType: a.targetType, targetId: a.targetId, before: a.before, after: a.after }))).toEqual([
      { action: "parent.details.save.failed", targetType: "parent", targetId: r.identity.parentId, before: null, after: { code: "stale" } }]);
    expect(revalidatedPaths()).toEqual([]);
    // Edited again from the current values, with the version they came with, it saves.
    expect(await save({ ...SHOWN, phone: "512-555-0333", ...NEW_ADDRESS }, "p:1")).toMatchObject({ ok: true, current: { version: "p:2" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { phone: "512-555-0333", ...NEW_ADDRESS }, version: 2 });
  });

  it("a form drawn for one row's details is never saved onto the other's after a shape save, whatever their versions", async () => {
    const { r } = await seedContactFamilies(stub);
    // Both rows at version 1, with details of their own: the person's shown, the family's not.
    await setPersonDetails(r.identity.parentId, { phone: "512-555-0601", line1: "1 Person Path", city: "Austin" }, 1);
    await setFamilyDetails(r.identity.familyId, { phone: "512-555-0602", line1: "2 Family Way", city: "Buda" }, 1);
    const person = await personDetails(r.identity.parentId), theFamily = await familyDetails(r.identity.familyId);
    asParent(r.identity);
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", form: { values: person.values, version: "p:1" } });
    // An Admin saves a shape with no parent type while the parent edits: the details are now the family's.
    await storeShape(NO_PARENT_TYPE);
    expect(await save({ ...person.values, city: "Round Rock" }, "p:1")).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: theFamily.values, version: "f:1" } });
    expect(await familyDetails(r.identity.familyId)).toEqual(theFamily);
    expect(await personDetails(r.identity.parentId)).toEqual(person);
    // And back: a form drawn for the family's details is not saved onto the person's.
    await db.delete(rateLimitEvent);
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", form: { values: theFamily.values, version: "f:1" } });
    await storeShape(); // a shape with a parent type again
    expect(await save({ ...theFamily.values, city: "Kyle" }, "f:1")).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: person.values, version: "p:1" } });
    expect(await personDetails(r.identity.parentId)).toEqual(person);
    expect(await familyDetails(r.identity.familyId)).toEqual(theFamily);
    expect((await audits()).map((a) => [a.action, a.after])).toEqual([["parent.details.save.failed", { code: "stale" }], ["parent.details.save.failed", { code: "stale" }]]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("two saves from forms shown the same version: the first is kept, the second is told and shown it", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, phone: NEW_PHONE })).toMatchObject({ ok: true, current: { version: "p:1" } });
    expect(await save({ ...SHOWN, city: "Buda" })).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: { ...SHOWN, phone: NEW_PHONE }, version: "p:1" } });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { ...SHOWN, phone: NEW_PHONE }, version: 1 });
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
  ] as [string, Partial<ContactValues>, string[]][])("refuses %s in a field the parent changed, and saves nothing", async (_what, bad, errors) => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, ...bad })).toEqual({ ok: false, errors });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: SHOWN, version: 0 });
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual([["parent.details.save.failed", r.identity.parentId, { code: "invalid" }]]);
    expect(revalidatedPaths()).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a field longer than the portal lets a parent type, left alone: a change of phone is not refused for it, and it is kept", async () => {
    const { r } = await seedContactFamilies(stub);
    // Taken in from QuickBooks, which holds more than the form lets a parent type.
    const city = "C".repeat(150), postalCode = "9".repeat(25);
    await setPersonDetails(r.identity.parentId, { city, postalCode });
    asParent(r.identity);
    const shown = { ...SHOWN, city, postalCode };
    expect(await loadMyContact(ctxOf(r.identity))).toMatchObject({ state: "ok", form: { values: shown } });
    expect(await save({ ...shown, phone: NEW_PHONE })).toMatchObject({ ok: true, message: CONTACT_COPY.saved });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { ...shown, phone: NEW_PHONE }, version: 1 });
    expect((await audits()).map((a) => [a.action, a.before, a.after])).toEqual([["parent.details.save", { phone: RIVERA.parent.phone }, { phone: NEW_PHONE }]]);
  });

  it("a field the parent did change is still checked, beside one too long that they left alone", async () => {
    const { r } = await seedContactFamilies(stub);
    await setPersonDetails(r.identity.parentId, { city: "C".repeat(150) });
    asParent(r.identity);
    const shown = { ...SHOWN, city: "C".repeat(150) };
    expect(await save({ ...shown, postalCode: "9".repeat(21), phone: "x".repeat(31) })).toEqual({ ok: false, errors: [
      "Phone can be up to 30 characters. Please shorten it.", "ZIP or postal code can be up to 20 characters. Please shorten it."] });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: shown, version: 0 });
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual([["parent.details.save.failed", r.identity.parentId, { code: "invalid" }]]);
  });

  it("refuses a field far too long to be a form's", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    expect(await save({ ...SHOWN, country: long(5000) })).toEqual({ ok: false, errors: [NOT_THE_FORM] });
    expect((await audits()).map((a) => [a.action, a.targetId, a.after])).toEqual([["parent.details.save.failed", null, { code: "invalid" }]]);
  });

  it("refuses anything that isn't the form: a file for a field, a version that isn't one, a missing field, something that isn't a form at all", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const without = contactForm(SHOWN, "p:0"); without.delete("city");
    const twice = contactForm(SHOWN, "p:0"); twice.append("phone", NEW_PHONE);
    const attempts: unknown[] = [
      contactForm(SHOWN, "p:0", { phone: new Blob(["512-555-0222"]) }), contactForm(SHOWN, ""), contactForm(SHOWN, "p:0 or 1=1"), contactForm(SHOWN, "p:1e3"), without,
      // A bare number (a page drawn before the version named whose details it carries), and a prefix that names nobody.
      contactForm(SHOWN, "0"), contactForm(SHOWN, "x:0"), contactForm(SHOWN, "p:"),
      { ...SHOWN, phone: NEW_PHONE, version: "p:0" }, null, "phone=512-555-0222", [contactForm(SHOWN, "p:0")],
    ];
    for (const attempt of attempts) {
      await db.delete(rateLimitEvent);
      expect(await saveDetailsAction(attempt as FormData)).toEqual({ ok: false, errors: [NOT_THE_FORM] });
    }
    // A field sent twice is read once, as a browser's form reads it: the first value.
    await db.delete(rateLimitEvent);
    expect(await saveDetailsAction(twice)).toMatchObject({ ok: true, message: CONTACT_COPY.nothingChanged });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: SHOWN, version: 0 });
  });

  it("lets a parent save a handful of times an hour, then refuses, and audits the first refusal only", async () => {
    const { r, c } = await seedContactFamilies(stub);
    asParent(r.identity);
    const max = RATE_LIMITS.contact_save_parent.max;
    expect(max).toBeLessThanOrEqual(10);
    for (let i = 0; i < max; i++) expect(await save({ ...SHOWN, phone: `512-555-03${10 + i}` }, `p:${i}`)).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) expect(await save({ ...SHOWN, phone: "512-555-0399" }, `p:${max}`)).toEqual({ ok: false, errors: [CONTACT_COPY.tooMany] });
    expect(await personDetails(r.identity.parentId)).toEqual({ values: { ...SHOWN, phone: `512-555-03${10 + max - 1}` }, version: max });
    const log = await audits();
    expect(log.map((a) => a.action)).toEqual([...Array.from({ length: max }, () => "parent.details.save"), "parent.details.save.failed"]);
    expect(log.at(-1)).toMatchObject({ after: { code: "rate_limited" }, actorId: r.identity.parentId });
    // Counted per person: the other family's parent is not held up.
    asParent(c.identity);
    expect(await save({ ...NO_DETAILS, phone: NEW_PHONE })).toMatchObject({ ok: true });
  });

  it("opening the page takes no rate limit and writes no audit row: it asks QuickBooks nothing", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    for (let i = 0; i < RATE_LIMITS.contact_open_parent.max + 3; i++) expect(await renderPage(FamilyDetailsPage)).toContain("Save my details");
    expect(await db.select().from(rateLimitEvent)).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("whose details come from the session and nothing else (v1 spec §12)", () => {
  it("as family A's parent with every field of family B's values and versions: nothing of B's person or family changes", async () => {
    const { a, b } = await seedTwoFamilies();
    await setPersonDetails(b.identity.parentId, {}, 7);
    await setFamilyDetails(b.identity.familyId, { phone: "737-555-0888", line1: "8021 Wrenhallow Drive" }, 5);
    const theirPerson = await personDetails(b.identity.parentId), theirFamily = await familyDetails(b.identity.familyId);
    const ids = [b.identity.parentId, String(b.identity.familyId), b.identity.guardianId, b.spec.parent.qboId, b.spec.family.qboId];
    // Every name a form could give an id, each naming B's person, family, row or record.
    const naming = (id: string) => Object.fromEntries(["id", "Id", "parentId", "personId", "familyId", "family", "guardianId", "customerId", "qboId", "recordId"].map((name) => [name, id]));
    const theirsUnchanged = async () => {
      expect(await personDetails(b.identity.parentId)).toEqual(theirPerson);
      expect(await familyDetails(b.identity.familyId)).toEqual(theirFamily);
      for (const row of await audits()) expect([String(a.identity.familyId), a.identity.parentId, null]).toContain(row.targetId);
    };
    asParent(a.identity);
    for (const [shape, whose] of [[null, "person"], [NO_PARENT_TYPE, "family"]] as const) {
      if (shape) await storeShape(shape);
      const theirs = whose === "person" ? theirPerson : theirFamily;
      const v = (n: number) => `${whose === "person" ? "p" : "f"}:${n}`;
      const mineNow = () => (whose === "person" ? personDetails(a.identity.parentId) : familyDetails(a.identity.familyId));
      // B's values with B's version, B's ids beside them: B's version is not A's, so nothing is saved, and what comes
      // back is A's own details, with nothing of B in it.
      for (const id of ids) {
        await db.delete(rateLimitEvent);
        const refused = await save(theirs.values, v(theirs.version), naming(id));
        expect(refused, `${whose} ${id}`).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: { values: (await mineNow()).values, version: v((await mineNow()).version) } });
        for (const marker of b.markers) expect(JSON.stringify(refused), marker).not.toContain(marker);
        await theirsUnchanged();
      }
      // B's values at A's own version, every id of B's beside them: they land in A's own details as text, and B's are as they were.
      await db.delete(rateLimitEvent);
      const before = await mineNow();
      expect(await save({ ...theirs.values, line2: ids.join(" ") }, v(before.version), naming(b.identity.parentId))).toMatchObject({ ok: true });
      expect(await mineNow()).toEqual({ values: { ...theirs.values, line2: ids.join(" ") }, version: before.version + 1 });
      await theirsUnchanged();
    }
    expect(stub.apiCalls()).toEqual([]);
  });

  it("refuses anyone who is not a signed-in parent with a family chosen, the same way whatever the reason", async () => {
    const { r } = await seedContactFamilies(stub);
    const form = () => contactForm({ ...SHOWN, phone: NEW_PHONE }, "p:0");
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    asParentChoosing(r.identity);
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    asStaff(await seedStaff({ email: "admin@example.org", admin: true }));
    await expect(saveDetailsAction(form())).rejects.toThrow("Not allowed");
    expect(await personDetails(r.identity.parentId)).toEqual({ values: SHOWN, version: 0 });
    expect(await audits()).toEqual([]);
  });

  it("a family whose record is not active gets nothing to edit, and a save changes nothing", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.update(family).set({ active: false }).where(eq(family.id, r.identity.familyId));
    asParent(r.identity);
    expect(await loadMyContact(ctxOf(r.identity))).toEqual({ state: "none" });
    await storeShape(NO_PARENT_TYPE);
    expect(await save({ ...NO_DETAILS, phone: NEW_PHONE })).toEqual({ ok: false, errors: [CONTACT_COPY.askTheClub] });
    expect(await familyDetails(r.identity.familyId)).toEqual({ values: NO_DETAILS, version: 0 });
  });
});
