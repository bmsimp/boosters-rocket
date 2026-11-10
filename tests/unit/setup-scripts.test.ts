import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const staff = readFileSync("scripts/setup/New-BoosterRocketStaffApp.ps1", "utf8");

describe("setup PowerShell scripts", () => {
  it.each([["staff", staff]])("%s script never uses device code and takes the app URL token", (_, s) => {
    expect(s).not.toMatch(/UseDeviceCode|devicecode|device_code/i);
    expect(s).toContain("'__BOOSTER_ROCKET_APP_URL__'");
    expect(s).toContain("Connect-MgGraph");
    expect(s).toContain("Disconnect-MgGraph");
    expect(s).not.toMatch(/Out-File|Set-Content|Export-/);
  });
  it("uses the redirect URIs the app serves", () => {
    expect(staff).toContain("/api/auth/staff/callback/microsoft");
  });
  it.each([["staff", staff]])("%s script has the token only in the param default", (_, s) => {
    expect(s.split("__BOOSTER_ROCKET_APP_URL__").length - 1).toBe(1);
    const replaced = s.replaceAll("__BOOSTER_ROCKET_APP_URL__", "https://portal.example.org");
    expect(replaced).not.toContain("__BOOSTER_ROCKET_APP_URL__");
  });
  it.each([["staff", staff]])("%s script connects in process scope only", (_, s) => {
    expect(s).toContain("-ContextScope Process");
  });
  it.each([["staff", staff]])("%s script disconnects in a finally block", (_, s) => {
    expect(s).toMatch(/finally\s*\{[\s\S]*Disconnect-MgGraph/);
  });
  it.each([["staff", staff]])("%s script uploads the certificate and never makes a secret", (_, s) => {
    expect(s).not.toMatch(/addPassword|secretText|passwordCredential/);
    expect(s.split("__BOOSTER_ROCKET_CERTIFICATE__")).toHaveLength(2);
    expect(s).toContain("$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'");
    expect(s).toContain("$select=keyCredentials");
    expect(s).toContain("AsymmetricX509Cert");
  });
  it.each([["staff", staff]])("%s script sends existing keyCredentials back", (_, s) => {
    expect(s).toMatch(/\$keys = @\(\$existing \| ForEach-Object \{ \$k = @\{[\s\S]*?\}[\s\S]*?\$keys \+= @\{ type = 'AsymmetricX509Cert'[\s\S]*?keyCredentials = @\(\$keys\)/);
    expect(s).toMatch(/didn't return this app's existing certificates/);
  });
  it.each([["staff", staff]])("%s script keeps existing certificates exactly and spots this one by key too", (_, s) => {
    for (const f of ["keyId", "customKeyIdentifier", "startDateTime", "endDateTime"]) expect(s).toMatch(new RegExp(`'${f}'`));
    expect(s).toContain("-eq $CertificateBase64");
    expect(s).toContain("This app has an expired certificate (");
    expect(s).toContain("which Microsoft won't accept back. Remove it in the Entra admin center under Certificates & secrets > Certificates, then run this script again.");
    expect(s).not.toMatch(/removeKey|\b(Invoke-MgGraphRequest|Send-Graph) DELETE/);
  });
});

describe("setup scripts find the existing app by listing, not by a name filter", () => {
  it.each([["staff", staff]])("%s script lists apps client-side and follows paging", (_, s) => {
    expect(s).toContain("function Get-AppsNamed");
    expect(s).toContain("@odata.nextLink");
    expect(s).toContain("$select=id,appId,displayName");
    expect(s).toContain("-ceq $DisplayName");
    expect(s).not.toContain("displayName eq");
  });
});

describe("staff script: the optional mail part", () => {
  const connect = staff.indexOf("Connect-ExchangeOnline -ShowBanner:$false");
  const mailPart = staff.slice(staff.indexOf("if ($SetUpMail)"));
  const at = (needle: string) => {
    const i = staff.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it("is opt-in and needs a mailbox that is an email address", () => {
    expect(staff).toContain("[switch]$SetUpMail");
    expect(staff).toContain("[string]$Mailbox");
    expect(staff).toMatch(/if \(\$SetUpMail -and -not \$Mailbox\) \{ throw/);
    expect(staff.indexOf("if ($SetUpMail)")).toBeGreaterThan(0);
    expect(staff).toMatch(/\$Mailbox -notmatch '[^']+'\) \{ throw/);
    expect(at("$Mailbox -notmatch")).toBeLessThan(connect);
  });
  it("refuses while the app holds unscoped Graph Mail.Send, before connecting to Exchange or creating anything there", () => {
    expect(mailPart).toContain("b633e1c5-b582-4048-a93e-9f11b44c7e96");
    expect(mailPart).toContain("would let it send as anyone");
    const refusal = at("/appRoleAssignments");
    expect(refusal).toBeLessThan(connect);
    expect(at("would let it send as anyone")).toBeLessThan(connect);
    expect(refusal).toBeLessThan(at("New-ServicePrincipal"));
  });
  it("connects to Exchange Online interactively, never with a device code, and disconnects", () => {
    expect(mailPart).toContain("Connect-ExchangeOnline -ShowBanner:$false");
    expect(mailPart).not.toMatch(/-Device|UseDeviceAuthentication/i);
    expect(mailPart).toMatch(/finally\s*\{[\s\S]*Disconnect-ExchangeOnline -Confirm:\$false/);
  });
  it("checks the Exchange tenant is the one being set up, between connecting and the first Exchange lookup or change", () => {
    const check = at("(Get-ConnectionInformation");
    expect(check).toBeGreaterThan(connect);
    expect(staff.slice(check, check + 400)).toContain("$tenant");
    expect(check).toBeLessThan(at("Get-EXOMailbox"));
    expect(check).toBeLessThan(at("New-ServicePrincipal"));
    expect(check).toBeLessThan(at("New-ManagementScope"));
  });
  it("scopes Application Mail.Send to the one looked-up mailbox, with one quote-safe filter", () => {
    expect(mailPart).toContain("New-ServicePrincipal -AppId $app.appId -ObjectId $sp.id");
    expect(mailPart).toContain("$mb = Get-EXOMailbox -Identity $Mailbox");
    expect(mailPart).toContain("Replace(\"'\", \"''\")");
    expect(mailPart).toContain("PrimarySmtpAddress -eq '$");
    expect(mailPart.split("PrimarySmtpAddress -eq").length - 1).toBe(1);
    expect(mailPart).toContain("New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter $filter");
    expect(mailPart).toContain("Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $filter");
    expect(mailPart).toContain("Test-ServicePrincipalAuthorization -Identity $sp.id -Resource $mailAddress");
    expect(mailPart).not.toMatch(/Add-MailboxPermission|New-ApplicationAccessPolicy|Mail\.Send'\s*=\s*'Role'/);
  });
  it("scopes the role assignment on both the create and the rescope path, and refuses when more than one exists", () => {
    expect(mailPart).toContain("New-ManagementRoleAssignment -App $sp.id -Role 'Application Mail.Send' -CustomResourceScope $ScopeName");
    expect(mailPart).toMatch(/Set-ManagementRoleAssignment -Identity \S+ -CustomResourceScope \$ScopeName/);
    expect(mailPart).toMatch(/\.Count -gt 1\) \{\s*throw/);
  });
  it("checks the mailbox exists before changing anything in Exchange", () => {
    expect(at("Get-EXOMailbox -Identity $Mailbox")).toBeLessThan(at("New-ServicePrincipal"));
    expect(mailPart).toMatch(/if \(-not \$mb\) \{\s*throw/);
  });
  it("proves every sending permission the app holds is limited to the scope, before claiming success", () => {
    const all = at("@(Test-ServicePrincipalAuthorization -Identity $sp.id)");
    expect(all).toBeLessThan(at("The app can now send as"));
    expect(all).toBeGreaterThan(at("CustomResourceScope $ScopeName"));
    const block = staff.slice(all, at("The app can now send as"));
    expect(block).toContain("Mail.Send");
    expect(block).toContain("AllowedResourceScope");
    expect(block).toContain("$ScopeName");
    expect(block).toContain("Remove");
    expect(block).toMatch(/throw/);
    expect(at("-Resource $mailAddress")).toBeLessThan(at("The app can now send as"));
  });
});
