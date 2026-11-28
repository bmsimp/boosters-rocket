import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { detailsSaved, type ContactSaved, type EmailSaved } from "@/lib/families/events";
import { guardianSaved, type GuardianEvent } from "@/lib/families/guardian-events";
import { queueContactChange, queueEmailChange } from "@/lib/parents/contact-queue";
import { queueForGuardian } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { setPersonDetails, takeInDone } from "../helpers/contact";
import { asOp, connectRoster, seedAnaRivera, staffWith } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Slice P6 of the accounting plugin spec (section 3, "Events"): every core save of a guardian or of a person's details
 * calls `records.events` inside its own transaction, and QuickBooks' handler queues there exactly what the save queued
 * before it had events. Proven here: an event in a transaction that rolls back leaves nothing on the queue; an event
 * queues the same rows as today's queueing function given the same save; and the worker sends today's requests for
 * them. The saves themselves are held to today's rows and requests by contact-sent-on, email-sent-on,
 * guardians-in-quickbooks and staff-contact-details, unchanged.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const NEW_PHONE = "512-555-0222";
const NO_ADDRESS = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
const items = () => db.select().from(writeQueue);
/** The queue's rows as the worker reads them: what each asks and of whom, not its own id or times. */
const asked = async () => (await items()).map((i) => ({ realmId: i.realmId, request: i.request, targetQboId: i.targetQboId, familyId: i.familyId, studentId: i.studentId,
  state: i.state, sent: i.sent, tries: i.tries, askedBy: i.askedBy, askedByLabel: i.askedByLabel }));
const bodies = () => stub.apiCalls().filter((c) => c.method === "POST").map((c) => JSON.parse(c.body) as Record<string, unknown>);
const wake = () => runWriteQueue(new Date(Date.now() + 2 * MIN));
class RolledBack extends Error {}
/** `f` in a transaction that is rolled back after it, as a save that fails after its event is. */
const rolledBack = (f: (tx: Tx) => Promise<unknown>) => db.transaction(async (tx) => { await f(tx); throw new RolledBack(); }).catch((e: unknown) => {
  if (!(e instanceof RolledBack)) throw e;
});

let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId;
beforeEach(async () => {
  await resetDb(); stub.reset();
  await connectRoster(stub);
  await takeInDone();
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family");
  stub.calls.length = 0;
});

/** Ana Rivera, whose own Parent customer is 11 under the Rivera Family, 10, with the phone the take-in copied (version 1). */
async function ana() {
  const seeded = await seedAnaRivera({ status: "active" });
  await setPersonDetails(seeded.ana.id, { phone: "555-0101" }, 1);
  const actor = { door: "parent" as const, id: seeded.ana.id, label: "ana@example.com" };
  const contact: ContactSaved = { record: "contact", of: { kind: "person", parentId: seeded.ana.id }, change: { phone: NEW_PHONE }, was: { phone: "555-0101" },
    now: { phone: NEW_PHONE, address: NO_ADDRESS } };
  return { ...seeded, actor, contact };
}

describe("a person's details: the event queues in the save's transaction, as the save did", () => {
  it("a phone's event rolled back with its save queues nothing; committed, it queues today's row, and the worker sends today's body", async () => {
    const a = await ana();
    const e = a.contact;
    await rolledBack((tx) => detailsSaved(tx, e, { actor: a.actor, ip: null }));
    expect(await items()).toEqual([]);
    const ids = await db.transaction((tx) => detailsSaved(tx, e, { actor: a.actor, ip: null }));
    expect(ids).toEqual((await items()).map((i) => i.id));
    const byEvent = await asked();
    expect(byEvent).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "11", askedBy: null,
      request: expect.objectContaining({ op: "contact", qboId: "11", change: { phone: NEW_PHONE }, was: { phone: "555-0101" }, guardianId: a.row.id }) })]);
    // The same save by today's queueing function: the same row.
    await db.delete(writeQueue);
    await db.transaction((tx) => queueContactChange(tx, e.of, { change: e.change, was: e.was, now: e.now }, { actor: a.actor, ip: null }));
    expect(await asked()).toEqual(byEvent);
    // The person's row as the save left it, which the worker checks the change against before it sends.
    await setPersonDetails(a.ana.id, { phone: NEW_PHONE }, 2);
    await wake();
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
  });

  it("a staff member's save holds its items for the at-once try, as it did (QueueAs)", async () => {
    const a = await ana();
    const nextTryAt = new Date(Date.now() + MIN);
    await db.transaction((tx) => detailsSaved(tx, a.contact, { actor: op.actor, ip: null, queueAs: { askedBy: op.staffUserId, nextTryAt } }));
    expect(await items()).toEqual([expect.objectContaining({ askedBy: op.staffUserId, nextTryAt })]);
  });

  it("a sign-in email's event rolled back queues nothing; committed, it queues what queueEmailChange() queues", async () => {
    const a = await ana();
    const email: EmailSaved = { record: "email", parentId: a.ana.id, from: "ana@example.com", to: "ana.r@example.com" };
    await rolledBack((tx) => detailsSaved(tx, email, { actor: a.actor, ip: null }));
    expect(await items()).toEqual([]);
    await db.transaction((tx) => detailsSaved(tx, email, { actor: a.actor, ip: null }));
    const byEvent = await asked();
    expect(byEvent).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "11", request: expect.objectContaining({ op: "email" }) })]);
    await db.delete(writeQueue);
    await db.transaction((tx) => queueEmailChange(tx, a.ana.id, { from: "ana@example.com", to: "ana.r@example.com" }, { actor: a.actor, ip: null }));
    expect(await asked()).toEqual(byEvent);
  });
});

describe("a guardian: the event queues in the save's transaction, as the save did", () => {
  const kit = async () => {
    const [p] = await db.insert(parent).values({ name: "Kit Rivera", email: "kit@example.com" }).returning();
    const [row] = await db.insert(guardian).values({ familyId: rivera, parentId: p!.id, status: "invited" }).returning();
    return row!;
  };

  it("a row opened: rolled back, nothing; committed, the Parent customer's create queueForGuardian() queues, and today's request", async () => {
    const row = await kit();
    const opened: GuardianEvent = { record: "guardian", change: "opened", guardianId: row.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" };
    await rolledBack((tx) => guardianSaved(tx, opened, op));
    expect(await items()).toEqual([]);
    expect(await db.transaction((tx) => guardianSaved(tx, opened, op))).toEqual([expect.objectContaining({ guardianId: row.id, outcome: "queued" })]);
    const byEvent = await asked();
    await db.delete(writeQueue);
    await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: row.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" }, op));
    expect(await asked()).toEqual(byEvent);
    await wake();
    expect(bodies()).toEqual([{ DisplayName: "Kit Rivera", CustomerTypeRef: { value: "2" }, ParentRef: { value: "10" }, Job: true, BillWithParent: false,
      PrimaryEmailAddr: { Address: "kit@example.com" } }]);
  });

  it("a person renamed and a row closed ask queueForGuardian() for today's rename and make-inactive", async () => {
    const a = await ana();
    const rows = [{ guardianId: a.row.id, familyId: rivera }];
    const renamed: GuardianEvent = { record: "guardian", change: "renamed", rows, name: "Ana M. Rivera", was: "Ana Rivera", email: "ana@example.com" };
    await rolledBack((tx) => guardianSaved(tx, renamed, op));
    expect(await items()).toEqual([]);
    await db.transaction((tx) => guardianSaved(tx, renamed, op));
    const renameByEvent = await asked();
    expect(renameByEvent).toEqual([expect.objectContaining({ targetQboId: "11", request: expect.objectContaining({ op: "rename", name: "Ana M. Rivera" }) })]);
    await db.delete(writeQueue);
    await db.transaction((tx) => queueForGuardian(tx, { op: "rename", rows, name: "Ana M. Rivera", was: "Ana Rivera", email: "ana@example.com" }, op));
    expect(await asked()).toEqual(renameByEvent);

    await db.delete(writeQueue);
    await db.transaction((tx) => guardianSaved(tx, { record: "guardian", change: "closed", guardianId: a.row.id, familyId: rivera }, op));
    const closeByEvent = await asked();
    expect(closeByEvent).toEqual([expect.objectContaining({ targetQboId: "11", request: expect.objectContaining({ op: "deactivate" }) })]);
    await db.delete(writeQueue);
    await db.transaction((tx) => queueForGuardian(tx, { op: "remove", guardianId: a.row.id, familyId: rivera }, op));
    expect(await asked()).toEqual(closeByEvent);
  });
});
