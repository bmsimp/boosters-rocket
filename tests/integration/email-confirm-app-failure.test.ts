import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * A parent's confirmed change of sign-in email (confirmMyEmailChange(), src/lib/parents/email-change.ts) whose app side
 * fails once QuickBooks has taken the address. Postgres ending the transaction for a deadlock is tried once more; a
 * second failure is recorded in a small transaction of its own, a roster refresh is asked for, and the parent is told
 * the portal can't tell yet. The request stays live, so opening the link again finishes the app's side, sending
 * QuickBooks nothing, and still does after the refresh asked for has put the new address in the roster cache: the
 * change finds the record while their live request names the address its field now holds
 * (loadMyRecordForMyEmailChange(), src/lib/parents/my-family.ts), and no longer once the link has expired; what the
 * pages show and edit goes by the sign-in address alone (loadMyRecord()), so it is no record of theirs there. The failure is made where it would happen: one of the transaction's own steps, the deletion of
 * the person's unused codes, ends it as Postgres would end the loser of a deadlock.
 */
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

const failing = vi.hoisted(() => ({ times: 0 }));
vi.mock("@/lib/parents/sessions", async (original) => {
  const real = await original<typeof import("@/lib/parents/sessions")>();
  return {
    ...real,
    // The change calls this inside its transaction, after it has changed the person's address.
    deleteUnusedSigninCodes: async (...args: Parameters<typeof real.deleteUnusedSigninCodes>) => {
      if (failing.times > 0) { failing.times--; throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); }
      return real.deleteUnusedSigninCodes(...args);
    },
  };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthSession, parentAuthUser, parentEmailChange, qboCustomer } from "@/lib/db/schema";
import { EMAIL_COPY, confirmMyEmailChange, findMyEmailChange } from "@/lib/parents/email-change";
import { loadMyRecord, loadMyRecordForMyEmailChange } from "@/lib/parents/my-family";
import { rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { syncAppRecords } from "../helpers/app-records";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { inQuickBooks, seedContactFamilies } from "../helpers/contact";
import { seedEmailChange } from "../helpers/email-change";
import { RIVERA } from "../helpers/money";
import type { SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const OLD = RIVERA.parent.email, NEW = "rosalind.retried@family-r.example";
const saves = async () => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((a) => a.action === "parent.email.save");
const addressOf = async (id: string) => (await db.select({ email: parent.email }).from(parent).where(eq(parent.id, id)))[0]!.email;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const sessionsOf = async (parentId: string) => db.select({ id: parentAuthSession.id }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId));

let r: SeededParent;
let token: string;
const confirm = () => confirmMyEmailChange({ ...r.identity, ip: null }, token);
/** What the roster refresh the fallback asks for does to the person's record: the cache takes QuickBooks' field. */
const refreshTakesTheField = async () => {
  await db.update(qboCustomer).set({ email: NEW }).where(eq(qboCustomer.qboId, RIVERA.parent.qboId));
  await syncAppRecords();
};

describe("the app side of a confirmed change of sign-in email, when its transaction fails", () => {
  beforeEach(async () => {
    failing.times = 0;
    await resetDb(); stub.reset(); outbox.length = 0;
    await seedWorkingMail();
    ({ r } = await seedContactFamilies(stub));
    ({ token } = await seedEmailChange({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyId: r.identity.familyId,
      recordQboId: RIVERA.parent.qboId, newEmail: NEW }));
  });

  it("is tried once more after a deadlock, and the change is made and audited once", async () => {
    failing.times = 1;
    expect(await confirm()).toMatchObject({ ok: true, signedOut: true });
    expect(failing.times).toBe(0);
    expect(await addressOf(r.identity.parentId)).toBe(NEW);
    expect(posts()).toHaveLength(1);
    expect((await saves()).map((a) => a.after)).toEqual([expect.objectContaining({ email: NEW, app: "changed" })]);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
  });

  it("failing twice, is recorded on its own with a refresh asked for, tells the parent it can't tell yet, and the link then finishes it", async () => {
    failing.times = 2;
    expect(await confirm()).toEqual({ ok: false, errors: [EMAIL_COPY.unsure] });
    // QuickBooks holds the new address; the app is as it was, and the request is still live.
    expect(inQuickBooks(stub, RIVERA.parent.qboId).PrimaryEmailAddr).toEqual({ Address: NEW });
    expect(await addressOf(r.identity.parentId)).toBe(OLD);
    expect(await sessionsOf(r.identity.parentId)).toHaveLength(1);
    expect((await db.select().from(parentEmailChange)).map((q) => q.usedAt)).toEqual([null]);
    // A write this call sent is always audited.
    const [failed, ...rest] = await saves();
    expect(rest).toEqual([]);
    expect(failed).toMatchObject({ targetType: "qbo_customer", targetId: RIVERA.parent.qboId, before: { email: OLD },
      after: { email: NEW, portal: "refresh_asked", code: "app_failed_40P01", app: "unchanged", quickbooks: "holds_new_address" } });
    expect(await rosterRefreshAsked()).toBe(true);
    // Opening the link again finds the change made in QuickBooks, sends nothing, and finishes the app's side.
    expect(await confirm()).toMatchObject({ ok: true, signedOut: true });
    expect(posts()).toHaveLength(1);
    expect(await addressOf(r.identity.parentId)).toBe(NEW);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect((await saves()).map((a) => (a.after as { app?: string }).app)).toEqual(["unchanged", "changed"]);
  });

  it("failing twice, is still finished by the link after the refresh it asked for has put the new address in the cache", async () => {
    failing.times = 2;
    expect(await confirm()).toEqual({ ok: false, errors: [EMAIL_COPY.unsure] });
    await refreshTakesTheField();
    // The field no longer holds the address the person signs in with, but it reads as the change their live link asks
    // for: the change still finds the record, the link still asks, and confirming finishes the app's side, sending
    // nothing. The pages, which go by the sign-in address alone, show and edit no record of theirs meanwhile.
    expect(await loadMyRecord({ ...r.identity, ip: null })).toBeNull();
    expect(await loadMyRecordForMyEmailChange({ ...r.identity, ip: null })).toMatchObject({ qboId: RIVERA.parent.qboId });
    expect(await findMyEmailChange({ ...r.identity, ip: null }, token)).toEqual({ state: "ask", newEmail: NEW });
    expect(await confirm()).toMatchObject({ ok: true, signedOut: true });
    expect(posts()).toHaveLength(1);
    expect(await addressOf(r.identity.parentId)).toBe(NEW);
    expect(await sessionsOf(r.identity.parentId)).toEqual([]);
    expect((await saves()).map((a) => (a.after as { app?: string }).app)).toEqual(["unchanged", "changed"]);
  });

  it("finds the record by the change only while the link lives", async () => {
    failing.times = 2;
    expect(await confirm()).toEqual({ ok: false, errors: [EMAIL_COPY.unsure] });
    await refreshTakesTheField();
    await db.update(parentEmailChange).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await loadMyRecordForMyEmailChange({ ...r.identity, ip: null })).toBeNull();
    expect(await findMyEmailChange({ ...r.identity, ip: null }, token)).toEqual({ state: "gone" });
  });
});
