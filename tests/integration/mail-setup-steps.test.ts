import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MicrosoftMailSetup } from "@/app/components/mail-settings/mail-steps";
import { mailSummary } from "@/lib/mail/settings";
import { invalidateProviders } from "@/lib/auth/providers";
import { resetDb, seedProvider, seedWorkingMail } from "../helpers/db";

const TENANT = "11111111-2222-3333-4444-555555555555";
const html = async () => renderToStaticMarkup(await MicrosoftMailSetup({ summary: await mailSummary() }));

describe("the Microsoft 365 mail steps", () => {
  beforeEach(async () => { await resetDb(); invalidateProviders(); });

  it("shows numbered steps in the open, not inside a collapsed section, until mail works", async () => {
    await seedProvider("staff-microsoft", { tenantId: TENANT, clientId: "c" }); invalidateProviders();
    const out = await html();
    expect(out).toContain("Do these steps in order");
    const download = out.indexOf('href="/setup/scripts/New-BoosterRocketStaffApp.ps1"');
    expect(download).toBeGreaterThan(-1);
    const firstDetails = out.indexOf("<details");
    expect(firstDetails === -1 || firstDetails > out.indexOf("Send test email")).toBe(true);
  });

  it("fills the club's own tenant ID into the command, so there is nothing to look up", async () => {
    await seedProvider("staff-microsoft", { tenantId: TENANT, clientId: "c" }); invalidateProviders();
    const out = await html();
    expect(out).toContain(`./New-BoosterRocketStaffApp.ps1 -TenantId ${TENANT} -SetUpMail -Mailbox &lt;mailbox&gt;`);
    expect(out).toContain('value="Unblock-File .\\New-BoosterRocketStaffApp.ps1"');
    expect(out).not.toContain("&lt;tenant&gt;");
    expect(out).not.toContain("&lt;your tenant ID&gt;");
  });

  it("uses the saved mailbox in the command, and tucks the steps away once mail works", async () => {
    await seedProvider("staff-microsoft", { tenantId: TENANT, clientId: "c" }); invalidateProviders();
    await seedWorkingMail({ method: "graph", mailbox: "webmaster@example.org" });
    const out = await html();
    expect(out).toContain(`-TenantId ${TENANT} -SetUpMail -Mailbox webmaster@example.org`);
    expect(out.startsWith("<details")).toBe(true);
  });

  it("shows nothing when staff don't sign in with Microsoft", async () => {
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    expect(await html()).toBe("");
  });
});
