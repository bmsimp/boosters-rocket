import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ setup: true, sent: 0 }));
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, startSetupSession: async () => {}, SETUP_COOKIE: "br_setup" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); } }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async () => { state.sent++; } }));

import { saveSetupMailAction, sendSetupTestMailAction, goToStepAction } from "@/app/setup/actions";
import { getSetupState } from "@/lib/setup/state";
import { mailWorking } from "@/lib/mail/settings";
import { SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { resetDb, seedProvider } from "../helpers/db";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const smtp = { method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "club@example.org", password: "p" };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string }).url;

describe("the Outgoing mail setup step", () => {
  beforeEach(async () => {
    await resetDb(); state.setup = true; state.sent = 0;
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
  });

  it("saves the settings, and a test send makes them work", async () => {
    expect(await saveSetupMailAction(form(smtp))).toEqual({ ok: true });
    expect(await mailWorking()).toBe(false);
    expect(await sendSetupTestMailAction(form({ to: "admin@example.org" }))).toEqual({ ok: true });
    expect(state.sent).toBe(1);
    expect(await mailWorking()).toBe(true);
  });

  it("won't go on to the first Admin until mail works", async () => {
    expect(await redirectOf(goToStepAction("mail"))).toBe("/setup?step=mail");
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=mail&error=mail_first");
    await saveSetupMailAction(form(smtp));
    await sendSetupTestMailAction(form({ to: "admin@example.org" }));
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=admin");
    expect((await getSetupState()).step).toBe("admin");
  });

  it("asks for a new setup code when the session has ended", async () => {
    state.setup = false;
    expect(await saveSetupMailAction(form(smtp))).toEqual({ ok: false, errors: [SETUP_SESSION_ENDED] });
    expect(await sendSetupTestMailAction(form({ to: "a@example.org" }))).toEqual({ ok: false, error: SETUP_SESSION_ENDED });
  });
});
