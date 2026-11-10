import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetDb } from "../helpers/db";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => null, hasStaffSession: async () => false }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { GET } from "@/app/setup/scripts/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("setup script download", () => {
  beforeEach(async () => { await resetDb(); state.setup = false; });
  it("is not found without a setup session or the permission", async () => {
    expect((await call("New-BoosterRocketStaffApp.ps1")).status).toBe(404);
  });
  it("serves the script with the site address filled in", async () => {
    state.setup = true;
    const res = await call("New-BoosterRocketStaffApp.ps1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[string]$AppUrl = 'http://localhost:3000'");
    expect(text).not.toContain("__BOOSTER_ROCKET_APP_URL__");
  });
  it("no longer serves the parent script", async () => {
    state.setup = true;
    expect((await call("New-BoosterRocketParentApp.ps1")).status).toBe(404);
  });
  it("serves nothing else", async () => {
    state.setup = true;
    expect((await call("..%2Fpackage.json")).status).toBe(404);
  });
  it("embeds the same certificate the .cer download serves", async () => {
    state.setup = true;
    const text = await (await call("New-BoosterRocketStaffApp.ps1")).text();
    const embedded = /\$CertificateBase64 = '([A-Za-z0-9+/=]+)'/.exec(text)![1]!;
    const { GET: cert } = await import("@/app/setup/certificates/[name]/route");
    const der = Buffer.from(await (await cert(new Request("http://x"), { params: Promise.resolve({ name: "booster-rocket-staff.cer" }) })).arrayBuffer());
    expect(embedded).toBe(der.toString("base64"));
    expect(text).not.toContain("__BOOSTER_ROCKET_CERTIFICATE__");
  });
});
