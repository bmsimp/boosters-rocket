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
import { askRosterWrite, REFRESH_ASK_KEY, WRITE_COPY } from "@/lib/roster/writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { NOT_HERE } from "@/lib/roster/operations";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { setRosterSource } from "@/lib/roster/source";
import { resetDb } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";

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
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
});

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

  it("adds a parent with their own email address, billed apart, and with parent sign-ins on they can sign in at once", async () => {
    await seedParentSettings(SIGNINS_ON);
    const r = await askRosterWrite({ op: "create", role: "parent", name: "Luis Rivera", familyQboId: "10", email: " Luis@Example.COM ", typeQboId: null }, tag, op);
    expect(r.ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Luis Rivera", CustomerTypeRef: { value: "2" }, ParentRef: { value: "10" }, Job: true, BillWithParent: false,
      PrimaryEmailAddr: { Address: "luis@example.com" } }]);
    const made = stub.customers.find((c) => c.DisplayName === "Luis Rivera")!;
    expect(await cached(made.Id as string)).toMatchObject({ email: "luis@example.com", typeQboId: "2" });
    const [person] = await db.select().from(parent).where(eq(parent.email, "luis@example.com"));
    expect(person).toBeDefined();
    const links = await db.select().from(guardian).where(eq(guardian.parentId, person!.id));
    expect(links).toEqual([expect.objectContaining({ familyQboId: "10", sourceQboId: made.Id, status: "invited" })]);
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

  it("makes a family inactive: its parents' access ends, and the worker is asked to read the roster again", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(WORKER); // read again with sign-ins on, so Ana has a link to the Rivera family
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana!.id)))[0]).toMatchObject({ status: "invited" });
    const r = await askRosterWrite({ op: "deactivate", qboId: "10", syncToken: "0" }, tag, op);
    expect(r).toEqual({ ok: true, message: "Made inactive in QuickBooks." });
    expect(sent()).toEqual([{ Id: "10", SyncToken: "0", sparse: true, Active: false }]);
    expect(await cached("10")).toMatchObject({ active: false });
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana!.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "family_inactive" });
    expect((await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY)))).toHaveLength(1);
    expect((await auditsOf("roster.customer.deactivate"))[0]!.after).toMatchObject({ active: false, refreshAsked: true });
  });

  it("makes a parent inactive: that parent's access ends", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(WORKER);
    const r = await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op);
    expect(r.ok).toBe(true);
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana!.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "inactive" });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]); // only a family's asks for a refresh
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
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.changed], current: { name: "Leo R. Rivera", active: true, familyName: "Rivera Family", syncToken: "3" } });
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
    expect(item).toMatchObject({ state: "waiting", sent: true, tries: 1, targetQboId: "12", familyQboId: "10", realmId: REALM, askedByLabel: "registrar@club.org",
      request: { op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" } });
    expect(item!.lastCode).toMatch(/^(unreachable|timeout)$/);
    expect(item!.nextTryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await auditsOf("roster.write.queued"))[0]).toMatchObject({ targetId: item!.id, after: { op: "rename", sent: true } });
  });

  it("an unreachable QuickBooks and a 5xx are queued as possibly made; a 429 as not made", async () => {
    tag = await connectRoster(stub);
    stub.dropApi = true;
    expect((await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.dropApi = false;
    stub.failNext = 1;
    expect((await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.rateLimitNext = 1;
    expect((await askRosterWrite({ op: "create", role: "family", name: "Patel Family", familyQboId: null, email: null, typeQboId: null }, tag, op))).toMatchObject({ ok: true, queued: true });
    const items = await queue();
    expect(items.map((i) => [i.request.op, i.sent, i.lastCode])).toEqual([["deactivate", true, "unreachable"], ["deactivate", true, "http_500"], ["create", false, "http_429"]]);
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
