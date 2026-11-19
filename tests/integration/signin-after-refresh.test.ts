import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * The whole way in, joined up, beside a roster refresh: a guardian the portal holds (since stage 3 of the app-owned
 * families spec, nothing makes one from QuickBooks) is in the family record the refresh keeps, asks for a code, enters
 * it, gets a session and reaches their family; and what QuickBooks then changes about their parent record changes
 * nothing about their sign-in. Only the family record going inactive stops it, at the gate.
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
// The request a page is rendered for (the browser's cookie and its address) is made up; the session read is real.
import { cookiesSetBy, fromBrowser } from "../helpers/page-request";

import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthSession, parentAuthUser, signinCode } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { getParentState } from "@/lib/auth/identity";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { env } from "@/env";
import { resetDb, seedGuardian, seedParent, seedWorkingMail } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { syncAppRecords } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const IP = "203.0.113.60";
const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
async function post(path: string, body: unknown) {
  return (await getParentAuth()).handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP },
  }));
}
const cookieFrom = cookiesSetBy;
/** Asks for a code as the sign-in page does and waits for the email; null when none came. */
async function codeMailedTo(typed: string): Promise<Msg | null> {
  const before = outbox.length;
  expect(await (await post("/portal-code/send", { email: typed })).json()).toEqual({ ok: true });
  try { await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(before), { timeout: 1500 }); } catch { return null; }
  return outbox.at(-1)!;
}
const codeIn = (m: Msg) => /sign-in code: (\d{6})/.exec(m.subject)![1]!;
const pageRequest = async (cookie: string) => { fromBrowser(cookie, IP); return getParentState(); };
const actions = async () => (await db.select().from(auditLog).orderBy(auditLog.id)).map((r) => r.action);
/** Ana Rivera as the portal holds her: the person, her sign-in account and an invited row in the Rivera family (customer 10) from her record (11). */
const seedAna = async () => {
  const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
  await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
  return ana;
};
/** A minute and more goes by: a second code may be asked for (the portal refuses one inside 60 seconds). */
const aMinutePasses = () => db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });

describe("a guardian the portal holds signs in beside the roster refresh", () => {
  beforeEach(async () => {
    await resetDb(); outbox.length = 0;
    stub.reset(); Object.assign(stub, fznCompany());
    await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await seedWorkingMail(); await seedParentSettings(SIGNINS_ON);
  });

  it("from the portal's own row to their family: refresh, code, session, and the family record migration 0023 made", async () => {
    const ana = await seedAna();
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    await syncAppRecords(); // the records, as 0023 made them from this roster: a read makes none (stage 3's slice 9c)
    // The refresh made nobody: Ana is the one person, as seeded, and QuickBooks' other records gave no one a sign-in.
    expect(await db.select().from(parent)).toHaveLength(1);
    const [link] = await db.select().from(guardian);
    expect(link).toMatchObject({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    // Her row names the family record of customer 10, which the gate enters.
    const familyId = link!.familyId;
    expect(familyId).not.toBeNull();
    expect(await db.select().from(parentAuthSession)).toEqual([]);

    // She types her address her own way and gets a code at the address the portal holds.
    const mail = await codeMailedTo("  ANA@example.COM ");
    expect(mail).toMatchObject({ to: "ana@example.com" });
    const res = await post("/portal-code/verify", { email: "Ana@Example.com", code: codeIn(mail!) });
    expect(await res.json()).toEqual({ ok: true, next: "/" });           // one family: straight in

    // The next page request is hers, in the Rivera family, and the link is active.
    const state = await pageRequest(cookieFrom(res));
    expect(state).toMatchObject({ status: "ok", identity: { door: "parent", parentId: ana.id, name: "Ana Rivera", email: "ana@example.com",
      familyId, guardianId: link!.id, families: [{ guardianId: link!.id, familyId }] } });
    // The identity names the app's family alone, and so does the session: no QuickBooks id of the family is stored.
    expect(JSON.stringify(state)).not.toContain('"10"');
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "active", disabledReason: null });
    const [account] = await db.select().from(parentAuthUser);
    const [session] = await db.select().from(parentAuthSession);
    expect(session).toMatchObject({ userId: account!.id, familyId });
    expect(session).not.toHaveProperty("familyQboId");
    expect(account).toMatchObject({ parentId: ana.id, email: "ana@example.com" });
    expect((await actions()).filter((a) => /^(parent\.|signin|guardian\.activate)/.test(a)))
      .toEqual(["signin.code_sent", "guardian.activate", "signin"]);
    const signedIn = (await db.select().from(auditLog)).find((r) => r.action === "signin");
    expect(signedIn).toMatchObject({ door: "parent", actorId: ana.id, targetId: ana.id, after: { familyId: String(familyId) }, ip: IP });

    // A second refresh that finds nothing changed leaves her signed in.
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await pageRequest(cookieFrom(res))).toMatchObject({ status: "ok", identity: { familyId } });
  }, 30_000);

  it("stays in when the refresh no longer finds her parent record, or her family: the app's records stand alone", async () => {
    await seedAna();
    await refreshRoster(worker);
    await syncAppRecords();
    const mail = await codeMailedTo("ana@example.com");
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: codeIn(mail!) });
    const cookie = cookieFrom(res);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });

    stub.customers = stub.customers.filter((c) => c.Id !== "11");
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "active", disabledReason: null });

    // The family itself leaves the roster QuickBooks sends: since stage 3's slice 9c its record stays active, so she
    // stays in (making a family inactive is a staff write, which changes its record too).
    stub.customers = stub.customers.filter((c) => c.Id !== "10" && c.Id !== "12");
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "active", disabledReason: null });
    await aMinutePasses();
    expect(await codeMailedTo("ana@example.com")).toMatchObject({ to: "ana@example.com" });
  }, 30_000);

  it("keeps signing in with the portal's address when QuickBooks changes the one on her record", async () => {
    const ana = await seedAna();
    await refreshRoster(worker);
    await syncAppRecords();
    const first = await codeMailedTo("ana@example.com");
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: codeIn(first!) });
    const cookie = cookieFrom(res);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });

    (stub.customers.find((c) => c.Id === "11") as { PrimaryEmailAddr: { Address: string } }).PrimaryEmailAddr = { Address: "Ana.New@Example.com" };
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    // The same person, the same address: her sign-in email is the app's record, and her session goes on.
    expect(await db.select().from(parent)).toEqual([expect.objectContaining({ id: ana.id, email: "ana@example.com" })]);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok", identity: { email: "ana@example.com" } });

    await aMinutePasses();
    expect(await codeMailedTo("ana.new@example.com")).toBeNull();
    expect(await codeMailedTo("ana@example.com")).toMatchObject({ to: "ana@example.com" });
  }, 30_000);
});
