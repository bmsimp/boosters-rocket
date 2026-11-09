import { describe, it, expect, vi, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, providerCertificate } from "@/lib/db/schema";
import { resetDb, seedCertificate } from "../helpers/db";

const state: { setup: boolean; staff: { staffUserId: string; email: string } | null; perm: boolean } = { setup: false, staff: null, perm: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => state.staff, hasStaffSession: async () => !!state.staff }));
vi.mock("@/lib/permissions/effective", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions/effective")>()),
  effectivePermissions: async () => ({ isAdmin: state.perm, permissions: new Set() }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { GET } from "@/app/setup/certificates/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("certificate download", () => {
  beforeEach(async () => { await resetDb(); state.setup = false; state.staff = null; state.perm = false; });

  it("is not found without a setup session or the permission", async () => {
    expect((await call("booster-rocket-staff.cer")).status).toBe(404);
  });

  it("serves a DER certificate, the same one on every download", async () => {
    state.setup = true;
    const a = await call("booster-rocket-staff.cer");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("application/pkix-cert");
    expect(a.headers.get("content-disposition")).toBe('attachment; filename="booster-rocket-staff.cer"');
    const der = Buffer.from(await a.arrayBuffer());
    expect(new X509Certificate(der).subject).toMatch(/^CN=Booster Rocket staff/);
    const b = Buffer.from(await (await call("booster-rocket-staff.cer")).arrayBuffer());
    expect(Buffer.compare(der, b)).toBe(0);
  });

  it("serves the active certificate when nothing is pending", async () => {
    state.setup = true;
    const active = await seedCertificate("parent-oidc", "active");
    const der = Buffer.from(await (await call("booster-rocket-parents.cer")).arrayBuffer());
    expect(new X509Certificate(der).fingerprint256.replaceAll(":", "")).toBe(
      Buffer.from(active.thumbprintS256, "base64url").toString("hex").toUpperCase());
  });

  it("refuses any other name", async () => {
    state.setup = true;
    expect((await call("..%2Fpackage.json")).status).toBe(404);
    expect((await call("booster-rocket-google.cer")).status).toBe(404);
  });

  it("lets a staff user with Settings.SignIn.ReadWrite download, recording who", async () => {
    const id = crypto.randomUUID();
    state.staff = { staffUserId: id, email: "admin@example.org" }; state.perm = true;
    expect((await call("booster-rocket-staff.cer")).status).toBe(200);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "certificate.create"));
    expect(audit).toMatchObject({ door: "staff", actorId: id, actorLabel: "admin@example.org" });
    const [row] = await db.select().from(providerCertificate);
    expect(row!.createdBy).toBe(id);
  });

  it("is not found for a staff user without the permission", async () => {
    state.staff = { staffUserId: crypto.randomUUID(), email: "x@example.org" }; state.perm = false;
    expect((await call("booster-rocket-staff.cer")).status).toBe(404);
  });

  it("records a first download in setup as the system", async () => {
    state.setup = true;
    await call("booster-rocket-staff.cer");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "certificate.create"));
    expect(audit).toMatchObject({ door: "system", actorLabel: "setup" });
  });

  it("creates nothing on a 404", async () => {
    await call("booster-rocket-staff.cer");
    state.setup = true;
    await call("booster-rocket-google.cer");
    await call("..%2Fpackage.json");
    expect(await db.select().from(providerCertificate)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("serves the pending certificate when both pending and active exist", async () => {
    state.setup = true;
    await seedCertificate("staff-microsoft", "active");
    const pending = await seedCertificate("staff-microsoft", "pending");
    const der = Buffer.from(await (await call("booster-rocket-staff.cer")).arrayBuffer());
    expect(new X509Certificate(der).fingerprint256.replaceAll(":", "")).toBe(
      Buffer.from(pending.thumbprintS256, "base64url").toString("hex").toUpperCase());
  });
});
