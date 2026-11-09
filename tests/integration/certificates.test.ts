import { describe, it, expect, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { db } from "@/lib/db/client";
import { providerCertificate, auditLog } from "@/lib/db/schema";
import {
  getOrCreatePendingCertificate, certificateRows, activatePendingCertificate, retireCertificates, openCertificateKey,
  certificateFileName, certificateKeyForFile,
} from "@/lib/auth/certificates";
import { resetDb } from "../helpers/db";

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
    const a = await getOrCreatePendingCertificate("parent-oidc", opts);
    const b = await getOrCreatePendingCertificate("parent-oidc", opts);
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
    await getOrCreatePendingCertificate("parent-oidc", opts);
    await db.transaction((tx) => activatePendingCertificate(tx, "parent-oidc", { actor, ip: null }));
    await getOrCreatePendingCertificate("parent-oidc", opts);
    await db.transaction((tx) => retireCertificates(tx, "parent-oidc", { actor, ip: null }));
    const rows = await db.select().from(providerCertificate);
    expect(rows.every((r) => r.status === "retired" && r.privateKeyCiphertext === null)).toBe(true);
  });

  it("maps file names both ways and refuses anything else", () => {
    expect(certificateFileName("staff-microsoft")).toBe("booster-rocket-staff.cer");
    expect(certificateFileName("parent-oidc")).toBe("booster-rocket-parents.cer");
    expect(certificateKeyForFile("booster-rocket-parents.cer")).toBe("parent-oidc");
    expect(certificateKeyForFile("../x.cer")).toBeNull();
  });
});
