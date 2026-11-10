import { describe, it, expect, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { db } from "@/lib/db/client";
import { providerCertificate, auditLog } from "@/lib/db/schema";
import {
  getOrCreatePendingCertificate, certificateRows, activatePendingCertificate, retireCertificates, openCertificateKey,
  certificateFileName, certificateKeyForFile, startCertificateReplacement, discardPendingCertificate,
} from "@/lib/auth/certificates";
import { eq } from "drizzle-orm";
import { resetDb, seedCertificate } from "../helpers/db";

const actor = { door: "system" as const, id: null, label: "setup" };
const opts = { actor, ip: null, createdBy: null };

describe("provider certificates", () => {
  beforeEach(resetDb);

  it("creates a pending certificate named for the site, sealed, and audited without key material", async () => {
    const row = await getOrCreatePendingCertificate("staff-microsoft", opts);
    expect(row.status).toBe("pending");
    expect(new X509Certificate(row.certificatePem).subject).toBe("CN=Booster Rocket staff (localhost)");
    expect(row.privateKeyCiphertext).not.toContain("PRIVATE KEY");
    expect(openCertificateKey(row)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => a.action)).toEqual(["certificate.create"]);
    expect(audit[0]!.after).toMatchObject({ providerKey: "staff-microsoft", thumbprintSha1: row.thumbprintSha1 });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
  });

  it("returns the same pending certificate on a second call", async () => {
    const a = await getOrCreatePendingCertificate("staff-microsoft", opts);
    const b = await getOrCreatePendingCertificate("staff-microsoft", opts);
    expect(b.id).toBe(a.id);
    expect(await db.select().from(providerCertificate)).toHaveLength(1);
  });

  it("makes only one pending certificate under concurrent calls", async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, () => getOrCreatePendingCertificate("staff-microsoft", opts)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
  });

  it("activates pending, retires the old active, and nulls the retired key", async () => {
    const first = await getOrCreatePendingCertificate("staff-microsoft", opts);
    await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }));
    const second = await getOrCreatePendingCertificate("staff-microsoft", opts);
    const active = await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }));
    expect(active!.id).toBe(second.id);
    const { pending, active: now } = await certificateRows("staff-microsoft");
    expect(pending).toBeNull();
    expect(now!.id).toBe(second.id);
    const [old] = (await db.select().from(providerCertificate)).filter((r) => r.id === first.id);
    expect(old).toMatchObject({ status: "retired", privateKeyCiphertext: null, privateKeyKeyId: null });
    expect(old!.retiredAt).not.toBeNull();
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(["certificate.create", "certificate.activate", "certificate.create", "certificate.retire", "certificate.activate"]);
  });

  it("activate does nothing without a pending certificate", async () => {
    expect(await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }))).toBeNull();
  });

  it("retireCertificates retires pending and active and nulls their keys", async () => {
    await getOrCreatePendingCertificate("staff-microsoft", opts);
    await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }));
    await getOrCreatePendingCertificate("staff-microsoft", opts);
    await db.transaction((tx) => retireCertificates(tx, "staff-microsoft", { actor, ip: null }));
    const rows = await db.select().from(providerCertificate);
    expect(rows.every((r) => r.status === "retired" && r.privateKeyCiphertext === null)).toBe(true);
  });

  it("startCertificateReplacement makes a new pending certificate while one is active, audited", async () => {
    const active = await seedCertificate("staff-microsoft", "active");
    const perm = "Settings.SignIn.ReadWrite";
    const staff = { door: "staff" as const, id: crypto.randomUUID(), label: "admin@example.org" };
    const pending = await startCertificateReplacement("staff-microsoft", { actor: staff, ip: "203.0.113.7", createdBy: staff.id, permission: perm });
    expect(pending.status).toBe("pending");
    expect(pending.thumbprintSha1).not.toBe(active.thumbprintSha1);
    expect(pending.createdBy).toBe(staff.id);
    const rows = await certificateRows("staff-microsoft");
    expect(rows.active!.id).toBe(active.id);
    expect(rows.pending!.id).toBe(pending.id);
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "certificate.create", door: "staff", actorId: staff.id, permission: perm, targetId: pending.id, ip: "203.0.113.7" });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
  });

  it("startCertificateReplacement keeps a readable pending certificate (pressing it twice changes nothing)", async () => {
    await seedCertificate("staff-microsoft", "active");
    const a = await startCertificateReplacement("staff-microsoft", opts);
    const b = await startCertificateReplacement("staff-microsoft", opts);
    expect(b.id).toBe(a.id);
    expect(await db.select().from(providerCertificate)).toHaveLength(2);
    expect((await db.select().from(auditLog)).map((x) => x.action)).toEqual(["certificate.create"]);
  });

  it("startCertificateReplacement makes one with nothing there, and only one under concurrent calls", async () => {
    const rows = await Promise.all(Array.from({ length: 4 }, () => startCertificateReplacement("staff-microsoft", opts)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await db.select().from(providerCertificate)).toHaveLength(1);
  });

  it("startCertificateReplacement retires a pending certificate it can't decrypt and makes a new one", async () => {
    const active = await seedCertificate("staff-microsoft", "active");
    const stale = await seedCertificate("staff-microsoft", "pending");
    await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" }).where(eq(providerCertificate.id, stale.id));
    const fresh = await startCertificateReplacement("staff-microsoft", opts);
    expect(fresh.id).not.toBe(stale.id);
    expect(openCertificateKey(fresh)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const [old] = await db.select().from(providerCertificate).where(eq(providerCertificate.id, stale.id));
    expect(old).toMatchObject({ status: "retired", privateKeyCiphertext: null, privateKeyKeyId: null });
    const rows = await certificateRows("staff-microsoft");
    expect(rows.pending!.id).toBe(fresh.id);
    expect(rows.active!.id).toBe(active.id);
    const audit = await db.select().from(auditLog);
    expect(audit.map((x) => [x.action, x.targetId])).toEqual([["certificate.retire", stale.id], ["certificate.create", fresh.id]]);
  });

  it("startCertificateReplacement replaces an active certificate whose key can't be decrypted", async () => {
    const active = await seedCertificate("staff-microsoft", "active");
    await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" });
    const pending = await startCertificateReplacement("staff-microsoft", opts);
    expect(pending.id).not.toBe(active.id);
    expect(openCertificateKey(pending)).not.toBeNull();
  });

  it("discardPendingCertificate retires the pending certificate, nulls its key, keeps the active one, and audits", async () => {
    const active = await seedCertificate("staff-microsoft", "active");
    const pending = await startCertificateReplacement("staff-microsoft", opts);
    const discarded = await discardPendingCertificate("staff-microsoft", { actor, ip: "203.0.113.7", permission: "Settings.SignIn.ReadWrite" });
    expect(discarded!.id).toBe(pending.id);
    const [row] = await db.select().from(providerCertificate).where(eq(providerCertificate.id, pending.id));
    expect(row).toMatchObject({ status: "retired", privateKeyCiphertext: null, privateKeyKeyId: null });
    expect(row!.retiredAt).not.toBeNull();
    const rows = await certificateRows("staff-microsoft");
    expect(rows.pending).toBeNull();
    expect(rows.active!.id).toBe(active.id);
    const audit = (await db.select().from(auditLog)).find((x) => x.action === "certificate.discard")!;
    expect(audit).toMatchObject({ targetType: "provider_certificate", targetId: pending.id, permission: "Settings.SignIn.ReadWrite", ip: "203.0.113.7",
      before: { status: "pending" }, after: { providerKey: "staff-microsoft", thumbprintSha1: pending.thumbprintSha1 } });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
  });

  it("discardPendingCertificate does nothing (and audits nothing) when nothing is pending", async () => {
    await seedCertificate("staff-microsoft", "active");
    expect(await discardPendingCertificate("staff-microsoft", { actor, ip: null })).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("maps file names both ways and refuses anything else", () => {
    expect(certificateFileName("staff-microsoft")).toBe("booster-rocket-staff.cer");
    expect(certificateKeyForFile("booster-rocket-staff.cer")).toBe("staff-microsoft");
    expect(certificateKeyForFile("booster-rocket-parents.cer")).toBeNull();
    expect(certificateKeyForFile("../x.cer")).toBeNull();
  });
});
