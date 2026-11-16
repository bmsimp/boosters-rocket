import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

// QuickBooks is the stub: nothing here can reach Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import HealthPage from "@/app/staff/(app)/health/page";
import { GET as liveness } from "@/app/api/health/route";
import { healthReport, BACKUP_OLD_MS, WORKER_LATE_MS, type HealthLine } from "@/lib/health/report";
import { BACKUP_KEY } from "@/lib/health/backup";
import { BUILD_VERSION } from "@/lib/health/version";
import { runDueJobs, WAKE_KEY } from "@/lib/jobs/runner";
import { CLEANUP_JOB } from "@/lib/jobs/cleanup";
import { patchMailStatus } from "@/lib/mail/settings";
import { ADMIN_ONLY } from "@/lib/permissions/registry";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const put = (key: string, value: unknown) => db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
const line = (lines: HealthLine[], key: HealthLine["key"]) => lines.find((l) => l.key === key)!;
const at = (l: HealthLine, label: string) => l.times.find((t) => t.label === label)?.at;
async function admin() { const s = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }); asStaff(s); return s; }

describe("the health page", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("is Admin only: the widest custom role is refused, and a visitor is sent to sign in", async () => {
    expect(ADMIN_ONLY).toContain("Admin.Health.Read");
    expect(await pageOutcome(HealthPage)).toEqual({ redirect: "/staff/sign-in" });
    const s = await seedStaff({ email: "wide@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values([{ roleId: r!.id, kind: "include", pattern: "*" }, { roleId: r!.id, kind: "include", pattern: "Admin.*" }, { roleId: r!.id, kind: "include", pattern: "Admin.Health.Read" }]);
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    asStaff(s);
    expect(await pageOutcome(HealthPage)).toEqual({ redirect: "/refused" });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "access.refused")).toMatchObject([{ actorId: s.id, permission: "Admin.Health.Read" }]);
  });

  it("on a portal that was just installed, says in plain words what isn't set up yet", async () => {
    await admin();
    const lines = await healthReport(NOW);
    expect(lines.map((l) => l.key)).toEqual(["database", "worker", "cleanup", "quickbooks", "mail", "parents", "backup", "version"]);
    expect(line(lines, "database")).toMatchObject({ state: "ok", word: "Working" });
    expect(line(lines, "worker")).toMatchObject({ state: "attention", times: [{ label: "Last woke", at: null }] });
    expect(line(lines, "worker").says).toMatch(/has never checked in/);
    expect(line(lines, "cleanup")).toMatchObject({ state: "off", word: "Not yet run" });
    expect(line(lines, "quickbooks")).toMatchObject({ state: "off", word: "Not set up" });
    expect(line(lines, "mail")).toMatchObject({ state: "attention", word: "Not set up" });
    expect(line(lines, "parents")).toMatchObject({ state: "off", word: "Off" });
    expect(line(lines, "backup")).toMatchObject({ state: "attention", word: "None recorded" });
    expect(line(lines, "backup").says).toMatch(/scripts\/backup\.sh/);
    expect(line(lines, "version").says).toBe(`Running ${BUILD_VERSION}.`);

    const html = await renderPage(HealthPage);
    expect(html).toContain("3 things need attention.");
    expect(html).toContain("The worker has never checked in.");
    expect(html).toContain("Last woke: never");
    expect(html).toContain(`Running ${BUILD_VERSION}.`);
    // The address the portal believes it has, as text. The browser adds whether it was reached there (tests/e2e/health.spec.ts).
    expect(html).toContain("This portal&#x27;s address is <code>http://localhost:3000</code>");
    for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.SETTINGS_ENCRYPTION_KEY!, "postgres://"]) expect(html).not.toContain(secret);
  });

  it("when everything works, says so, with when each part last worked", async () => {
    await admin();
    await seedConnected(stub);
    await seedWorkingMail();
    await patchMailStatus({ lastSuccessAt: ago(60_000) });
    await seedParentSettings(SIGNINS_ON);
    await put(BACKUP_KEY, { at: ago(3_600_000), file: "booster-rocket-20261115T030000Z.dump", bytes: 3 * 1024 * 1024 });
    await runDueJobs(); // a wake: the clean-up, the token refresh and the roster read all run
    const lines = await healthReport();
    for (const l of lines) expect(l.state, `${l.key}: ${l.says} ${l.notes.join(" ")}`).toBe("ok");
    expect(line(lines, "worker").says).toBe("Waking every minute to run the scheduled jobs.");
    expect(Date.parse(at(line(lines, "worker"), "Last woke")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(line(lines, "cleanup")).toMatchObject({ word: "Working", notes: ["Nothing to remove."] });
    expect(line(lines, "quickbooks").says).toMatch(/^Connected to .+ \(an Intuit sandbox, not the club's real books\)\.$/);
    expect(Date.parse(at(line(lines, "quickbooks"), "Last token refresh")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(at(line(lines, "quickbooks"), "Last roster read")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(line(lines, "mail")).toMatchObject({ word: "Working", says: "Tested and working, sending through Microsoft 365.", times: [{ label: "Last sent", at: ago(60_000) }, { label: "Last failure", at: null }] });
    expect(line(lines, "parents")).toMatchObject({ word: "On" });
    expect(line(lines, "backup")).toMatchObject({ word: "Recent", notes: ["booster-rocket-20261115T030000Z.dump, 3.0 MB"], times: [{ label: "Last backup", at: ago(3_600_000) }] });

    const html = await renderPage(HealthPage);
    expect(html).toContain("Everything that is set up is working.");
    expect(html).toContain("Last failure: never");
    // Nothing of the connection but its name: no client id, no token, no company id.
    const [conn] = await db.select().from(qboConnection);
    for (const hidden of [conn!.clientId, conn!.realmId!, conn!.accessTokenCiphertext!, conn!.refreshTokenCiphertext!]) expect(html).not.toContain(hidden);
  });

  it("warns when the worker has not woken for too long: a second inside the limit is fine, a second past it is not", async () => {
    await put(WAKE_KEY, { at: ago(WORKER_LATE_MS - 1000) });
    expect(line(await healthReport(NOW), "worker")).toMatchObject({ state: "ok", word: "Working" });
    await put(WAKE_KEY, { at: ago(WORKER_LATE_MS + 1000) });
    const late = line(await healthReport(NOW), "worker");
    expect(late).toMatchObject({ state: "attention", word: "Needs attention", times: [{ label: "Last woke", at: ago(WORKER_LATE_MS + 1000) }] });
    expect(late.says).toMatch(/has stopped checking in/);
  });

  it("warns when the last backup is more than two days old, and reads a value it can't trust as no backup", async () => {
    await put(BACKUP_KEY, { at: ago(BACKUP_OLD_MS - 1000), file: "booster-rocket-x.dump", bytes: 2048 });
    expect(line(await healthReport(NOW), "backup")).toMatchObject({ state: "ok", notes: ["booster-rocket-x.dump, 2 KB"] });
    await put(BACKUP_KEY, { at: ago(BACKUP_OLD_MS + 1000), file: "booster-rocket-x.dump", bytes: 2048 });
    expect(line(await healthReport(NOW), "backup")).toMatchObject({ state: "attention", word: "Needs attention" });
    for (const bad of [{ at: "not a time" }, { file: "x" }, "yesterday", 5, { at: 12345 }]) {
      await put(BACKUP_KEY, bad);
      expect(line(await healthReport(NOW), "backup"), JSON.stringify(bad)).toMatchObject({ state: "attention", word: "None recorded", times: [{ label: "Last backup", at: null }] });
    }
  });

  it("says when mail is untested, and when the last send failed", async () => {
    await put("mail", { method: "graph", mailbox: "webmaster@example.org" });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "attention", word: "Not tested" });
    await db.delete(setting).where(eq(setting.key, "mail"));
    await seedWorkingMail();
    await patchMailStatus({ lastSuccessAt: ago(120_000), lastFailureAt: ago(60_000), lastError: "The mail server refused the sign-in. (auth)" });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "attention", word: "Needs attention", notes: ["The mail server refused the sign-in. (auth)"],
      times: [{ label: "Last sent", at: ago(120_000) }, { label: "Last failure", at: ago(60_000) }] });
    await patchMailStatus({ lastSuccessAt: ago(30_000) });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "ok" });
  });

  it("says when QuickBooks is set up but not connected, and passes on what needs attention when it is", async () => {
    await seedConnected(stub);
    await db.update(qboConnection).set({ lastError: "Intuit refused the refresh. (invalid_grant)", lastErrorAt: new Date() });
    const broken = line(await healthReport(), "quickbooks");
    expect(broken).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/settings/quickbooks" } });
    expect(broken.notes.join(" ")).toContain("Intuit refused the refresh. (invalid_grant)");
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, accessTokenCiphertext: null, lastError: null });
    expect(line(await healthReport(), "quickbooks")).toMatchObject({ state: "attention", word: "Not connected" });
  });

  it("says when the last clean-up failed", async () => {
    await db.insert(jobRun).values({ job: CLEANUP_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "failed", detail: "The clean-up couldn't finish. Nothing was removed. (unexpected)" });
    expect(line(await healthReport(), "cleanup")).toMatchObject({ state: "attention", times: [{ label: "Last tried" }] });
  });

  it("leaves /api/health a bare liveness check that says nothing else", async () => {
    await admin();
    const res = await liveness();
    expect(await res.text()).toBe('{"ok":true}');
    expect([...res.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });
});
