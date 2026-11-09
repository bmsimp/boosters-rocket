import { describe, it, expect, vi, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { resetDb, seedCertificate } from "../helpers/db";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => null, hasStaffSession: async () => false }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { GET } from "@/app/setup/certificates/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("certificate download", () => {
  beforeEach(async () => { await resetDb(); state.setup = false; });

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
});
