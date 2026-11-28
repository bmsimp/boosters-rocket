import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { asStaff, pageOutcome, renderPage, signedOut } from "../helpers/signed-in";
import { createHash, createHmac, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, backupFile, backupRequest, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { env } from "@/env";
import BackupsPage from "@/app/staff/(app)/settings/backups/page";
import { backUpNowAction, prepareDownloadAction, restoreBackupAction, saveOffsiteAction, saveScheduleAction, stopOffsiteAction, testOffsiteAction } from "@/app/staff/(app)/settings/backups/actions";
import { GET as downloadRoute } from "@/app/staff/(app)/settings/backups/download/route";
import { NOT_ANSWERING } from "@/lib/backups/requests";
import { OFFSITE_KEY, PBKDF2_ITER, sendOffsiteCopies } from "@/lib/backups/offsite";
import { healthReport } from "@/lib/health/report";
import { resetDb, seedStaff } from "../helpers/db";

/**
 * Settings, Backups from the app's side (docs/superpowers/specs/2026-11-28-in-app-backups-design.md): the page, every
 * action and the download, Admin only, each audited; the backup service itself is stood in for by the rows it writes
 * (its heartbeat, the folder's mirror, a finished request), as tests/integration/backup-agent.test.ts runs it for real.
 */
type Staff = Awaited<ReturnType<typeof seedStaff>>;
let admin: Staff, other: Staff;
const OUTBOX = env.BACKUP_OUTBOX;
const STAMP = "20261124T030000Z";

async function widest(email: string): Promise<Staff> {
  const s = await seedStaff({ email });
  const [r] = await db.insert(role).values({ key: `r-${email}`, name: "Everything a role can have" }).returning();
  await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
}
const beat = (at = new Date()) => db.insert(setting).values({ key: "backup.agent", value: { at: at.toISOString(), version: 1, freeBytes: 40 * 1024 ** 3, nextAt: null, schedule: "03:00", keep: 14, zone: "UTC" } })
  .onConflictDoUpdate({ target: setting.key, set: { value: { at: at.toISOString(), version: 1, freeBytes: 40 * 1024 ** 3, nextAt: null, schedule: "03:00", keep: 14, zone: "UTC" } } });
const liveSchema = async () => Number((await db.execute<{ m: string }>(sql`select max(created_at)::text as m from drizzle.__drizzle_migrations`))[0]!.m);
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const route = (id: string | null) => downloadRoute(new Request(`http://localhost/staff/settings/backups/download${id ? `?id=${id}` : ""}`));

beforeEach(async () => {
  await resetDb();
  admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
  other = await seedStaff({ email: "other@club.org", name: "Otto Other", admin: true });
  mkdirSync(OUTBOX, { recursive: true });
  signedOut();
});
afterAll(() => rmSync(OUTBOX, { recursive: true, force: true }));

describe("who may", () => {
  it("is an Admin alone: the widest custom role is refused the page and every action", async () => {
    asStaff(await widest("wide@club.org"));
    expect(await pageOutcome(BackupsPage)).not.toHaveProperty("html");
    for (const act of [() => backUpNowAction(), () => saveScheduleAction(new FormData()), () => prepareDownloadAction(STAMP), () => restoreBackupAction(STAMP),
      () => saveOffsiteAction(new FormData()), () => testOffsiteAction(), () => stopOffsiteAction()]) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("the page", () => {
  it("says the backup service isn't answering, and leaves out what needs it", async () => {
    asStaff(admin);
    const html = await renderPage(BackupsPage);
    expect(html).toContain("The backup service on the server isn&#x27;t answering");
    expect(html).not.toContain("Back up now");
  });

  it("shows the last backup, the schedule and the backups on the server, with their presses", async () => {
    await beat();
    await db.insert(setting).values({ key: "backup.last_success", value: { at: "2026-11-24T03:00:00Z", file: `booster-rocket-${STAMP}.dump`, bytes: 3_000_000, documenso: null } });
    await db.insert(backupFile).values({ backupAt: STAMP, portalBytes: 3_000_000, documensoBytes: 1_000_000, schemaAt: await liveSchema() });
    asStaff(admin);
    const html = await renderPage(BackupsPage);
    for (const words of ["Back up now", "Every night at 3:00 AM. Keeps the newest 14.", "Change the schedule", "Restore this backup", "Download", "Set up off-site copies", "40.0 GB", "3.8 MB", "Included"]) expect(html).toContain(words);
    expect(html).toContain("is lost, and anyone who signed in since then signs in again. A backup of how things are now is made first.");
  });
});

describe("back up now", () => {
  it("is refused while the service isn't answering, then asks once, audited, and says so for a second press", async () => {
    asStaff(admin);
    expect(await backUpNowAction()).toEqual({ ok: false, errors: [NOT_ANSWERING] });
    await beat(new Date(Date.now() - 5 * 60_000));
    expect((await backUpNowAction()).ok).toBe(false);
    await beat();
    expect(await backUpNowAction()).toMatchObject({ ok: true });
    expect(await backUpNowAction()).toEqual({ ok: false, errors: ["A backup is already under way. It shows here when it is done."] });
    const rows = await db.select().from(backupRequest);
    expect(rows).toEqual([expect.objectContaining({ kind: "backup", requestedBy: admin.id, requestedLabel: "admin@club.org", finishedAt: null })]);
    expect(await audits("backup.run.request")).toEqual([expect.objectContaining({ actorId: admin.id, targetId: rows[0]!.id, permission: "Admin.Backups.ReadWrite" })]);
  });
});

describe("the schedule", () => {
  const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  it("takes a time or off and 1 to 60 to keep, audited with before and after", async () => {
    asStaff(admin);
    for (const bad of [{ at: "25:00", keep: "14" }, { at: "03:00", keep: "0" }, { at: "03:00", keep: "61" }, { at: "", keep: "3" }, { at: "03:00", keep: "x" }]) {
      expect((await saveScheduleAction(form(bad))).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(await saveScheduleAction("not a form")).toMatchObject({ ok: false });
    expect((await saveScheduleAction(form({ at: "02:30", keep: "30" }))).ok).toBe(true);
    expect((await saveScheduleAction(form({ at: "", off: "on", keep: "7" }))).ok).toBe(true);
    const [s] = await db.select().from(setting).where(eq(setting.key, "backup.schedule"));
    expect(s!.value).toEqual({ at: "off", keep: 7 });
    const rows = await audits("backup.schedule.update");
    expect(rows.map((r) => [r.before, r.after])).toEqual([[null, { at: "02:30", keep: 30 }], [{ at: "02:30", keep: 30 }, { at: "off", keep: 7 }]]);
  });
});

describe("a download", () => {
  it("is asked for only of a backup the server has, audited", async () => {
    await beat();
    asStaff(admin);
    for (const bad of ["20200101T000000Z", "../../etc/passwd", 7, null]) expect((await prepareDownloadAction(bad)).ok, String(bad)).toBe(false);
    await db.insert(backupFile).values({ backupAt: STAMP, portalBytes: 10, schemaAt: 1 });
    expect((await prepareDownloadAction(STAMP)).ok).toBe(true);
    expect(await db.select({ kind: backupRequest.kind, backupAt: backupRequest.backupAt }).from(backupRequest)).toEqual([{ kind: "download", backupAt: STAMP }]);
    expect(await audits("backup.download.request")).toHaveLength(1);
  });

  it("is taken once, by the Admin who asked, within 15 minutes, no-store with a fixed name, and is removed once sent", async () => {
    const make = async (by: string, finishedAt = new Date()) => {
      const [r] = await db.insert(backupRequest).values({ kind: "download", backupAt: STAMP, requestedBy: by, requestedLabel: "x", claimedAt: finishedAt, finishedAt, outcome: "ok", words: "Ready to download." }).returning();
      writeFileSync(path.join(OUTBOX, `${r!.id}.tar`), "the backup's bytes");
      await db.update(backupRequest).set({ result: { file: `${r!.id}.tar`, bytes: 18 } }).where(eq(backupRequest.id, r!.id));
      return r!.id;
    };
    const mine = await make(admin.id), theirs = await make(other.id), old = await make(admin.id, new Date(Date.now() - 16 * 60_000));
    expect((await route(mine)).status).toBe(404); // signed out
    asStaff(await widest("wide@club.org"));
    expect((await route(mine)).status).toBe(404);
    asStaff(admin);
    for (const id of [theirs, old, "not-an-id", null]) expect((await route(id)).status, String(id)).toBe(404);
    const r = await route(mine);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="boosters-rocket-backup.tar"');
    expect(await r.text()).toBe("the backup's bytes");
    await new Promise((done) => setTimeout(done, 200));
    expect(existsSync(path.join(OUTBOX, `${mine}.tar`))).toBe(false);
    expect((await route(mine)).status).toBe(404);
    expect(await audits("backup.download.fetch")).toEqual([expect.objectContaining({ actorId: admin.id, targetId: mine })]);
  });
});

describe("a restore", () => {
  it("is asked for only of a backup of the running version, and not while a backup is under way, audited", async () => {
    await beat();
    asStaff(admin);
    await db.insert(backupFile).values([{ backupAt: STAMP, portalBytes: 10, schemaAt: await liveSchema() }, { backupAt: "20261101T030000Z", portalBytes: 10, schemaAt: 1 }]);
    expect(await restoreBackupAction("20261101T030000Z")).toEqual({ ok: false, errors: ["This backup was made by another version of the portal, so it can't be put back from here."] });
    await db.insert(backupRequest).values({ kind: "backup" });
    expect((await restoreBackupAction(STAMP)).ok).toBe(false);
    await db.delete(backupRequest);
    expect((await restoreBackupAction(STAMP)).ok).toBe(true);
    expect(await audits("backup.restore.request")).toEqual([expect.objectContaining({ actorId: admin.id, after: { kind: "restore", backupAt: STAMP } })]);
  });
});

describe("off-site copies", () => {
  const SECRET = "s3cr3t-access-key-value", KEY_ID = "AKIDEXAMPLE1234";
  let server: Server | null = null;
  const puts: { url: string; headers: IncomingMessage["headers"]; body: Buffer; valid: boolean }[] = [];
  /** A stand-in for S3-compatible storage that checks each PUT's Signature Version 4, worked out here on its own. */
  async function storage(status = 200): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const h = req.headers, amz = String(h["x-amz-date"]), day = amz.slice(0, 8);
        const canonical = ["PUT", req.url, "", `host:${h.host}`, `x-amz-content-sha256:${h["x-amz-content-sha256"]}`, `x-amz-date:${amz}`, "", "host;x-amz-content-sha256;x-amz-date", "UNSIGNED-PAYLOAD"].join("\n");
        const scope = `${day}/auto/s3/aws4_request`;
        const toSign = ["AWS4-HMAC-SHA256", amz, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
        let k = createHmac("sha256", `AWS4${SECRET}`).update(day).digest();
        for (const part of ["auto", "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
        const want = `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${createHmac("sha256", k).update(toSign).digest("hex")}`;
        const valid = h.authorization === want;
        puts.push({ url: req.url!, headers: h, body: Buffer.concat(chunks), valid });
        res.statusCode = valid ? status : 403; res.end();
      });
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const a = server.address();
    return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }
  const form = (endpoint: string, secret = SECRET) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ endpoint, region: "auto", bucket: "club-backups", folder: "portal", accessKeyId: KEY_ID, secret })) f.set(k, v);
    return f;
  };
  afterAll(() => { server?.close(); });

  it("are off until set up; the first set-up shows the passphrase once and seals the secrets; the page never shows them", async () => {
    puts.length = 0;
    const endpoint = await storage();
    asStaff(admin);
    for (const bad of ["ftp://x.example", "http://storage.example.com", "https://storage.example.com/path"]) expect((await saveOffsiteAction(form(bad))).ok, bad).toBe(false);
    const saved = await saveOffsiteAction(form(endpoint));
    expect(saved.ok).toBe(true);
    const pass = /passphrase for these copies is (\S+)\./.exec(saved.ok ? saved.message : "")![1]!;
    const [row] = await db.select().from(setting).where(eq(setting.key, OFFSITE_KEY));
    const stored = JSON.stringify(row!.value);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(pass);
    expect(row!.value).toMatchObject({ on: true, bucket: "club-backups", accessKeyId: KEY_ID });
    const html = await renderPage(BackupsPage);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(pass);
    expect(html).toContain("Stop off-site copies");
    // A change with the secret left blank keeps it and the passphrase; no passphrase is shown again.
    const again = await saveOffsiteAction(form(endpoint, ""));
    expect(again).toEqual({ ok: true, message: "Saved. Off-site copies use these settings from the next backup." });
    expect(await testOffsiteAction()).toEqual({ ok: true, message: "It works: a small test file was written to the storage." });
    expect(puts.at(-1)).toMatchObject({ url: "/club-backups/portal/boosters-rocket-connection-test.txt", valid: true });
    const audited = JSON.stringify(await db.select().from(auditLog).where(sql`${auditLog.action} like 'backup.offsite.%'`));
    expect(audited).not.toContain(SECRET);
    expect(audited).not.toContain(pass);

    // The worker copies a backup the agent staged: encrypted in OpenSSL's format, which decrypts to the staged file.
    await db.insert(backupFile).values({ backupAt: STAMP, portalBytes: 10, schemaAt: 1 });
    const staged = Buffer.from("a staged backup, ".repeat(200));
    writeFileSync(path.join(OUTBOX, `upload-${STAMP}.tar`), staged);
    const [up] = await db.insert(backupRequest).values({ kind: "upload", backupAt: STAMP, claimedAt: new Date(), finishedAt: new Date(), outcome: "ok", words: "Ready.", result: { file: `upload-${STAMP}.tar`, bytes: staged.length } }).returning();
    expect(await sendOffsiteCopies()).toEqual({ sent: 1, failed: 0 });
    const put = puts.at(-1)!;
    expect(put).toMatchObject({ url: `/club-backups/portal/boosters-rocket-${STAMP}.tar.enc`, valid: true });
    expect(put.body.subarray(0, 8).toString("latin1")).toBe("Salted__");
    const kiv = pbkdf2Sync(pass, put.body.subarray(8, 16), PBKDF2_ITER, 48, "sha256");
    const d = createDecipheriv("aes-256-cbc", kiv.subarray(0, 32), kiv.subarray(32));
    expect(Buffer.concat([d.update(put.body.subarray(16)), d.final()]).equals(staged)).toBe(true);
    expect(existsSync(path.join(OUTBOX, `upload-${STAMP}.tar`))).toBe(false);
    expect((await db.select().from(backupFile))[0]).toMatchObject({ offsiteOutcome: "ok" });
    expect((await db.select().from(backupRequest).where(eq(backupRequest.id, up!.id)))[0]!.result).toMatchObject({ sent: true, ok: true });
    expect(await sendOffsiteCopies()).toEqual({ sent: 0, failed: 0 });
    expect((await healthReport()).find((l) => l.key === "backup_offsite")).toMatchObject({ state: "ok", word: "Copied" });

    expect((await stopOffsiteAction()).ok).toBe(true);
    expect(await db.select().from(setting).where(eq(setting.key, OFFSITE_KEY))).toEqual([]);
    expect((await healthReport()).find((l) => l.key === "backup_offsite")).toBeUndefined();
    expect((await audits("backup.offsite.remove"))).toHaveLength(1);
  });

  it("say plainly when the storage refuses the key", async () => {
    const endpoint = await storage(403);
    asStaff(admin);
    expect((await saveOffsiteAction(form(endpoint, "a-wrong-secret-value"))).ok).toBe(true);
    const r = await testOffsiteAction();
    expect(r).toEqual({ ok: false, errors: ["The storage refused the key. Check the access key ID, the secret and that the key may write to this bucket."] });
    expect(await audits("backup.offsite.test")).toEqual([expect.objectContaining({ after: { ok: false, status: 403 } })]);
  });
});

describe("Health", () => {
  it("has a line for the backup service: not answering, answering, and low on space", async () => {
    const line = async () => (await healthReport()).find((l) => l.key === "backup_agent")!;
    expect(await line()).toMatchObject({ state: "attention", word: "Not answering" });
    await beat();
    expect(await line()).toMatchObject({ state: "ok", word: "Answering", notes: ["40.0 GB free where the backups are kept"] });
    await db.update(setting).set({ value: { at: new Date().toISOString(), version: 1, freeBytes: 1024 ** 3, nextAt: null, schedule: "03:00", keep: 14, zone: "UTC" } }).where(eq(setting.key, "backup.agent"));
    expect(await line()).toMatchObject({ state: "attention", word: "Low on space" });
    await beat(new Date(Date.now() - 10 * 60_000));
    expect(await line()).toMatchObject({ state: "attention", word: "Not answering" });
  });
});
