import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => null, hasStaffSession: async () => false }));

import { GET } from "@/app/setup/scripts/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("setup script download", () => {
  beforeEach(() => { state.setup = false; });
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
  it("serves nothing else", async () => {
    state.setup = true;
    expect((await call("..%2Fpackage.json")).status).toBe(404);
  });
});
