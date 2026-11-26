import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ setup: true }));
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, startSetupSession: async () => {}, SETUP_COOKIE: "br_setup" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/setup",
  useSearchParams: () => new URLSearchParams(),
}));

import { eq } from "drizzle-orm";
import { prerender } from "react-dom/static";
import SetupPage from "@/app/setup/page";
import { saveSetupClubAction, goToStepAction, saveFirstAdminAction } from "@/app/setup/actions";
import { getSetupState, updateSetupState } from "@/lib/setup/state";
import { getClubSettings } from "@/lib/settings/club";
import { claimBootstrapAdmin } from "@/lib/auth/bootstrap";
import { SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { db } from "@/lib/db/client";
import { auditLog, staffUser } from "@/lib/db/schema";
import { resetDb, seedProvider, seedStaff, seedWorkingMail } from "../helpers/db";

const CLUB = { name: "Lakeside Marching Band", shortName: "LMB", color: "#f2c200", timeZone: "America/Chicago" };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string } | undefined)?.url;
async function page(step?: string): Promise<string> {
  const { prelude } = await prerender(await SetupPage({ searchParams: Promise.resolve(step ? { step } : {}) }));
  return (await new Response(prelude).text()).replaceAll("<!-- -->", "");
}
const progress = (html: string) => [.../<ol class="setup-progress">(.*?)<\/ol>/.exec(html)![1]!.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1]);

describe("setup asks for the club first on a new installation", () => {
  beforeEach(async () => { await resetDb(); state.setup = true; });

  it("opens on the club step, from an empty database, with four steps", async () => {
    expect((await getSetupState()).step).toBe("club");
    const html = await page();
    expect(progress(html)).toEqual(["1. Your club", "2. Staff sign-in", "3. Outgoing mail", "4. First Admin"]);
    expect(html).toContain("Step 1: Your club");
    // The form starts blank, never with the default name.
    expect(html).not.toContain('value="Boosters Rocket"');
    expect(html).toMatch(/<button class="btn" disabled="">Next: staff sign-in/);
  });

  it("saves the name, short name, color and time zone by the Club settings' rules, and audits it", async () => {
    expect(await saveSetupClubAction({ ...CLUB, name: "", shortName: "TOOLONG", color: "purple" })).toEqual({ ok: false, errors: [
      "Club name is required.", "Short name must be 4 characters or fewer.", "Color must be a hex value like #5b2a86."] });
    expect(await saveSetupClubAction({ ...CLUB, timeZone: "+05:00" })).toEqual({ ok: false, errors: ["Choose a time zone from the list."] });
    expect(await saveSetupClubAction({ ...CLUB, name: 42 })).toEqual({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
    expect((await getClubSettings()).name).toBe("Boosters Rocket");
    expect(await saveSetupClubAction(CLUB)).toEqual({ ok: true, message: "Saved. Go on to staff sign-in when you're ready." });
    expect(await getClubSettings()).toMatchObject({ ...CLUB, treasurerEmail: null });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "settings.club.save"));
    expect(row).toMatchObject({ door: "system", actorLabel: "setup", after: { ...CLUB, treasurerEmail: null } });
    const html = await page("club");
    expect(html).toContain('value="Lakeside Marching Band"');
    expect(html).toMatch(/<button class="btn">Next: staff sign-in/);
    expect(await redirectOf(goToStepAction("staff"))).toBe("/setup?step=staff");
    expect(await page()).toContain("Step 2: Staff sign-in");
  });

  it("won't go on to the first Admin, by the button, the address or the form, until the club has a name", async () => {
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await seedWorkingMail();
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=club&error=club_first");
    expect(await redirectOf(page("admin"))).toBe("/setup?step=club&error=club_first");
    expect(await saveFirstAdminAction(null, form({ name: "Ana Rivera", email: "ana@club.org" }))).toEqual({ error: "Give the club its name first (step 1)." });
    expect((await getSetupState()).adminEmail).toBeNull();
    expect(await page("club")).toContain("Step 1: Your club");
    await saveSetupClubAction(CLUB);
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=admin");
  });

  it("asks for the first Admin's name with their email, and the Admin made at sign-in carries that name, not the email", async () => {
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await seedWorkingMail();
    await saveSetupClubAction(CLUB);
    expect(await page("admin")).toContain("Admin&#x27;s name");
    expect(await saveFirstAdminAction(null, form({ name: "  ", email: "ana@club.org" }))).toEqual({ error: "Enter the Admin's name." });
    expect(await saveFirstAdminAction(null, form({ name: " Ana Rivera ", email: "Ana@Club.org" }))).toEqual({ saved: "Saved. Now sign in below as the Admin." });
    expect(await getSetupState()).toMatchObject({ step: "admin", adminEmail: "ana@club.org", adminName: "Ana Rivera" });
    const id = await claimBootstrapAdmin("ana@club.org");
    const [made] = await db.select().from(staffUser).where(eq(staffUser.id, id!));
    expect(made).toMatchObject({ name: "Ana Rivera", email: "ana@club.org", status: "active" });
  });

  it("gives an existing record named only by its email the Admin's name, and leaves a real name as it is", async () => {
    await saveSetupClubAction(CLUB);
    await seedStaff({ email: "ana@club.org", name: "ana@club.org", status: "invited" });
    await updateSetupState({ step: "admin", adminEmail: "ana@club.org", adminName: "Ana Rivera" });
    await claimBootstrapAdmin("ana@club.org");
    expect((await db.select().from(staffUser))[0]!.name).toBe("Ana Rivera");
    await resetDb();
    await seedStaff({ email: "ana@club.org", name: "Ana R.", status: "invited" });
    await updateSetupState({ step: "admin", adminEmail: "ana@club.org", adminName: "Ana Rivera" });
    await claimBootstrapAdmin("ana@club.org");
    expect((await db.select().from(staffUser))[0]!.name).toBe("Ana R.");
  });

  it("doesn't ask an existing installation again: a reopened setup starts at staff sign-in, with three steps", async () => {
    await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    await updateSetupState({ status: "open", step: "staff" });
    const html = await page();
    expect(progress(html)).toEqual(["1. Staff sign-in", "2. Outgoing mail", "3. First Admin"]);
    expect(html).toContain("Step 1: Staff sign-in");
    expect(await page("club")).toContain("Step 1: Staff sign-in");
    // And the first Admin step isn't held back for a club it doesn't ask about.
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await seedWorkingMail();
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=admin");
  });

  it("asks for a new setup code when the session has ended, and saves nothing", async () => {
    state.setup = false;
    expect(await saveSetupClubAction(CLUB)).toEqual({ ok: false, errors: [SETUP_SESSION_ENDED] });
    expect(await saveFirstAdminAction(null, form({ name: "Ana", email: "ana@club.org" }))).toEqual({ error: SETUP_SESSION_ENDED });
    expect((await getClubSettings()).name).toBe("Boosters Rocket");
  });
});
