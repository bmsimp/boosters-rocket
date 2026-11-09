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
  it("parent script requests Domain.Read.All for the tenant domain lookup", () => {
    expect(parent).toContain("'Domain.Read.All'");
  });
  it.each([["staff", staff], ["parent", parent]])("%s script connects in process scope only", (_, s) => {
    expect(s).toContain("-ContextScope Process");
  });
  it.each([["staff", staff], ["parent", parent]])("%s script disconnects in a finally block", (_, s) => {
    expect(s).toMatch(/finally\s*\{[\s\S]*Disconnect-MgGraph/);
  });
  it("turns sign-up off and uses email one-time passcode", () => {
    expect(parent).toContain("isSignUpAllowed = $false");
    expect(parent).toContain("EmailOtpSignup-OAUTH");
  });
  it.each([["staff", staff], ["parent", parent]])("%s script uploads the certificate and never makes a secret", (_, s) => {
    expect(s).not.toMatch(/addPassword|secretText|passwordCredential/);
    expect(s.split("__BOOSTER_ROCKET_CERTIFICATE__")).toHaveLength(2);
    expect(s).toContain("$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'");
    expect(s).toContain("$select=keyCredentials");
    expect(s).toContain("AsymmetricX509Cert");
  });
  it.each([["staff", staff], ["parent", parent]])("%s script sends existing keyCredentials back", (_, s) => {
    expect(s).toMatch(/\$keys = @\(\$existing \| ForEach-Object \{ \$k = @\{[\s\S]*?\}[\s\S]*?\$keys \+= @\{ type = 'AsymmetricX509Cert'[\s\S]*?keyCredentials = @\(\$keys\)/);
    expect(s).toMatch(/didn't return this app's existing certificates/);
  });
  it.each([["staff", staff], ["parent", parent]])("%s script keeps existing certificates exactly and spots this one by key too", (_, s) => {
    for (const f of ["keyId", "customKeyIdentifier", "startDateTime", "endDateTime"]) expect(s).toMatch(new RegExp(`'${f}'`));
    expect(s).toContain("-eq $CertificateBase64");
    expect(s).toContain("This app has an expired certificate (");
    expect(s).toContain("which Microsoft won't accept back. Remove it in the Entra admin center under Certificates & secrets > Certificates, then run this script again.");
    expect(s).not.toMatch(/removeKey|\b(Invoke-MgGraphRequest|Send-Graph) DELETE/);
  });
});

describe("setup scripts find the existing app by listing, not by a name filter", () => {
  it.each([["staff", staff], ["parent", parent]])("%s script lists apps client-side and follows paging", (_, s) => {
    expect(s).toContain("function Get-AppsNamed");
    expect(s).toContain("@odata.nextLink");
    expect(s).toContain("$select=id,appId,displayName");
    expect(s).toContain("-ceq $DisplayName");
    expect(s).not.toContain("displayName eq");
  });
});
