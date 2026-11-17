import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * The whole way in, joined up: a roster refresh with parent sign-ins switched on makes the person and their link, and
 * that person then asks for a code, enters it, gets a session and reaches their family. The sign-in tests seed their
 * people by hand and the reconcile tests stop at the rows; this is the path between them, with nothing seeded by hand
 * but the QuickBooks company (a stub of Intuit's API), working mail and the two settings an Admin saves.
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
import { resetDb, seedWorkingMail } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";

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
/** A minute and more goes by: a second code may be asked for (the portal refuses one inside 60 seconds). */
const aMinutePasses = () => db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });

describe("a parent the roster refresh made signs in", () => {
  beforeEach(async () => {
    await resetDb(); outbox.length = 0;
    stub.reset(); Object.assign(stub, fznCompany());
    await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await seedWorkingMail(); await seedParentSettings(SIGNINS_ON);
  });

  it("from QuickBooks to their family: refresh, code, session, and the family the roster gave them", async () => {
    expect(await db.select().from(parent)).toEqual([]);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    // Ana Rivera is the one parent in the company with an address (" Ana@Example.com " in QuickBooks). The refresh made her.
    const [ana] = await db.select().from(parent);
    expect(await db.select().from(parent)).toHaveLength(1);
    expect(ana).toMatchObject({ name: "Ana Rivera", email: "ana@example.com", blocked: false });
    const [link] = await db.select().from(guardian);
    expect(link).toMatchObject({ parentId: ana!.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);

    // She types her address her own way and gets a code at the address QuickBooks holds.
    const mail = await codeMailedTo("  ANA@example.COM ");
    expect(mail).toMatchObject({ to: "ana@example.com" });
    const res = await post("/portal-code/verify", { email: "Ana@Example.com", code: codeIn(mail!) });
    expect(await res.json()).toEqual({ ok: true, next: "/" });           // one family: straight in

    // The next page request is hers, in the Rivera family, and the link is active.
    const state = await pageRequest(cookieFrom(res));
    expect(state).toMatchObject({ status: "ok", identity: { door: "parent", parentId: ana!.id, name: "Ana Rivera", email: "ana@example.com",
      familyQboId: "10", guardianId: link!.id, families: [{ guardianId: link!.id, familyQboId: "10" }] } });
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "active", disabledReason: null });
    const [account] = await db.select().from(parentAuthUser);
    const [session] = await db.select().from(parentAuthSession);
    expect(session).toMatchObject({ userId: account!.id, familyQboId: "10" });
    expect(account).toMatchObject({ parentId: ana!.id, email: "ana@example.com" });
    expect((await actions()).filter((a) => /^(parent\.create|parent\.access\.granted|signin|guardian\.activate)/.test(a)))
      .toEqual(["parent.create", "parent.access.granted", "signin.code_sent", "guardian.activate", "signin"]);
    const signedIn = (await db.select().from(auditLog)).find((r) => r.action === "signin");
    expect(signedIn).toMatchObject({ door: "parent", actorId: ana!.id, targetId: ana!.id, after: { familyQboId: "10" }, ip: IP });

    // A second refresh that finds nothing changed leaves her signed in.
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await pageRequest(cookieFrom(res))).toMatchObject({ status: "ok", identity: { familyQboId: "10" } });
  }, 30_000);

  it("and is out again with the refresh that no longer finds them in QuickBooks", async () => {
    await refreshRoster(worker);
    const mail = await codeMailedTo("ana@example.com");
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: codeIn(mail!) });
    const cookie = cookieFrom(res);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });

    stub.customers = stub.customers.filter((c) => c.Id !== "11");
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await pageRequest(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "disabled", disabledReason: "not_in_quickbooks" });
    await aMinutePasses();
    expect(await codeMailedTo("ana@example.com")).toBeNull();
  }, 30_000);

  it("and signs in with the new address, and no longer with the old, after QuickBooks changes it", async () => {
    await refreshRoster(worker);
    const first = await codeMailedTo("ana@example.com");
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: codeIn(first!) });
    const cookie = cookieFrom(res);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    const [ana] = await db.select().from(parent);

    (stub.customers.find((c) => c.Id === "11") as { PrimaryEmailAddr: { Address: string } }).PrimaryEmailAddr = { Address: "Ana.New@Example.com" };
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    // The same person, a new address; the session proved with the old one is over.
    expect(await db.select().from(parent)).toEqual([expect.objectContaining({ id: ana!.id, email: "ana.new@example.com" })]);
    expect(await pageRequest(cookie)).toEqual({ status: "none" });

    await aMinutePasses();
    expect(await codeMailedTo("ana@example.com")).toBeNull();
    const second = await codeMailedTo("ana.new@example.com");
    expect(second).toMatchObject({ to: "ana.new@example.com" });
    const again = await post("/portal-code/verify", { email: "ana.new@example.com", code: codeIn(second!) });
    expect(await again.json()).toEqual({ ok: true, next: "/" });
    expect(await pageRequest(cookieFrom(again))).toMatchObject({ status: "ok", identity: { parentId: ana!.id, email: "ana.new@example.com", familyQboId: "10" } });
  }, 30_000);
});
