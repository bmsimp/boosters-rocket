import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const staff = readFileSync("scripts/setup/New-BoosterRocketStaffApp.ps1", "utf8");
const parent = readFileSync("scripts/setup/New-BoosterRocketParentApp.ps1", "utf8");

describe("setup PowerShell scripts", () => {
  it.each([["staff", staff], ["parent", parent]])("%s script never uses device code and takes the app URL token", (_, s) => {
    expect(s).not.toMatch(/UseDeviceCode|devicecode|device_code/i);
    expect(s).toContain("'__BOOSTER_ROCKET_APP_URL__'");
    expect(s).toContain("Connect-MgGraph");
    expect(s).toContain("Disconnect-MgGraph");
    expect(s).not.toMatch(/Out-File|Set-Content|Export-/);
  });
  it("uses the redirect URIs the app serves", () => {
    expect(staff).toContain("/api/auth/staff/callback/microsoft");
    expect(parent).toContain("/api/auth/parent/callback/parent-oidc");
  });
  it.each([["staff", staff], ["parent", parent]])("%s script has the token only in the param default", (_, s) => {
    expect(s.split("__BOOSTER_ROCKET_APP_URL__").length - 1).toBe(1);
    const replaced = s.replaceAll("__BOOSTER_ROCKET_APP_URL__", "https://portal.example.org");
    expect(replaced).not.toContain("__BOOSTER_ROCKET_APP_URL__");
  });
  it("turns sign-up off and uses email one-time passcode", () => {
    expect(parent).toContain("isSignUpAllowed = $false");
    expect(parent).toContain("EmailOtpSignup-OAUTH");
  });
});
