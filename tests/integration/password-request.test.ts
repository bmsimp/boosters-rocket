import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
/** How the mail sender behaves: as a working one, failing every send, or never finishing one. */
const sender = vi.hoisted(() => ({ mode: "works" as "works" | "fails" | "hangs" }));
vi.mock("@/lib/mail/senders", () => ({
  SMTP_PASSWORD_AAD: "mail:smtp-password",
  buildSender: async () => async (m: Msg) => {
    if (sender.mode === "fails") throw new Error("the mail server said no");
    if (sender.mode === "hangs") await new Promise(() => undefined);
    outbox.push(m);
  },
}));
import { fromIp, renderPage } from "../helpers/signed-in";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthUser, parentSigninToken, rateLimitEvent, setting } from "@/lib/db/schema";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { hashAskedAddress } from "@/lib/parents/password-request";
import { takeRateLimit, RATE_LIMITS } from "@/lib/parents/rate-limit";
import { linkVerdict } from "@/lib/parents/signin-links";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { askPasswordLinkAction } from "@/app/sign-in/password-actions";
import RequestPage from "@/app/sign-in/password/page";
import SignInPage from "@/app/sign-in/page";
import { resetDb, seedGuardianInFamily, seedParent, seedStaff, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { seedPassword } from "../helpers/signin-links";

/**
 * "Set up or reset my password" (the sign-in release, slice SI-3a): a visitor types an address and is always answered
 * the same; a set-up link is mailed to a person with no password and a reset link to one with a password, only when the
 * portal may mail them, and nothing to anyone else.
 */
const IP = "203.0.113.71";
const ANSWER = { ok: true, message: PASSWORD_COPY.askAnswer };
const ask = (email: unknown) => askPasswordLinkAction(email);
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const asked = () => audits("parent.password.reset_asked");
const reasons = async () => (await asked()).map((r) => r.after as { outcome: string; reason?: string; limit?: string });
/** The link a mail holds, and the token in it. */
const linkIn = (m: Msg) => /\/sign-in\/(set-up|reset)\/([A-Za-z0-9_-]{43})/.exec(m.text);
// An ask that mails nothing starts no send at all (askForPasswordLink() returns before one), so "nothing was mailed" is
// read as soon as the answer is back: there is nothing to wait for.

/** Everyone the page meets, each a guardian of an active family of the app's own unless it says otherwise. */
async function seedEveryone() {
  const guardianOf = async (name: string, email: string, o: { blocked?: boolean } = {}) => {
    const p = await seedParent({ name, email, blocked: o.blocked });
    const row = await seedGuardianInFamily({ parentId: p.id, familyQboId: "F1" });
    return { ...p, row };
  };
  const noPassword = await guardianOf("Ana", "ana@example.com");
  const withPassword = await guardianOf("Ben", "ben@example.com");
  await seedPassword(withPassword.authUserId, "a phrase Ben chose some time ago");
  const blocked = await guardianOf("Cy", "cy@example.com", { blocked: true });
  const noRow = await guardianOf("Dee", "dee@example.com");
  await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, noRow.row.id));
  const noAccount = await guardianOf("Eli", "eli@example.com");
  await db.delete(parentAuthUser).where(eq(parentAuthUser.parentId, noAccount.id));
  await seedStaff({ email: "coach@example.org" });
  return { noPassword, withPassword, blocked, noRow, noAccount };
}
const OUTSIDERS = ["nobody@example.com", "coach@example.org"];

describe("asking for a set-up or reset link", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; sender.mode = "works"; fromIp(IP); });

  it("answers the same for every address, mails a set-up link and a reset link to the two it may, and nothing to anyone else", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword, withPassword, blocked, noRow, noAccount } = await seedEveryone();
    const answers = [];
    for (const email of ["ana@example.com", "  BEN@example.com ", ...OUTSIDERS, "cy@example.com", "dee@example.com", "eli@example.com", "not an address"]) {
      answers.push(await ask(email));
    }
    for (const a of answers) expect(a).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(outbox.map((m) => m.to).sort()).toEqual(["ana@example.com", "ben@example.com"]);

    const setup = outbox.find((m) => m.to === "ana@example.com")!, reset = outbox.find((m) => m.to === "ben@example.com")!;
    expect(linkIn(setup)![1]).toBe("set-up");
    expect(linkIn(reset)![1]).toBe("reset");
    expect(await linkVerdict("setup", linkIn(setup)![2])).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await linkVerdict("reset", linkIn(reset)![2])).toMatchObject({ ok: true, link: { parentId: withPassword.id } });

    // One row per ask: against the person when the address is theirs, naming nobody otherwise.
    const rows = await asked();
    expect(rows).toHaveLength(answers.length);
    const of = (id: string) => rows.find((r) => r.targetId === id)!;
    expect(of(noPassword.id)).toMatchObject({ door: "parent", actorId: noPassword.id, targetType: "parent", after: { outcome: "setup" }, ip: IP });
    expect(of(withPassword.id)).toMatchObject({ actorId: withPassword.id, after: { outcome: "reset" } });
    expect(of(blocked.id).after).toEqual({ outcome: "none", reason: "blocked" });
    expect(of(noRow.id).after).toEqual({ outcome: "none", reason: "no_enabled_guardian" });
    expect(of(noAccount.id).after).toEqual({ outcome: "none", reason: "no_sign_in_account" });
    const nobody = rows.filter((r) => r.targetId === null);
    expect(nobody.map((r) => r.after)).toEqual([{ outcome: "none", reason: "unknown_email" }, { outcome: "none", reason: "unknown_email" }, { outcome: "none", reason: "not_an_address" }]);
    for (const r of nobody) expect(r).toMatchObject({ actorId: null, actorLabel: null, targetType: null });
    // The mint's own row, as SI-2 wrote it, for each link made.
    expect((await audits("parent.password.link_made")).map((r) => (r.after as { purpose: string }).purpose).sort()).toEqual(["reset", "setup"]);
  });

  it("the mailed link opens its page with the form", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    const SetUpPage = (await import("@/app/sign-in/set-up/[token]/page")).default;
    const html = await renderPage(SetUpPage, { params: { token: linkIn(outbox[0]!)![2]! } });
    expect(html).toContain('type="password"');
    expect(html).toContain(PASSWORD_COPY.setupTitle);
  });

  it("mails nothing, answering the same, while sign-ins are off, mail isn't working, or the club is at Strict", async () => {
    const cases: Record<string, { set: () => Promise<void>; reasons: string[] }> = {
      "sign-ins off": { set: async () => { await seedWorkingMail(); }, reasons: ["signins_off", "signins_off"] },
      "mail not working": { set: async () => { await seedParentSettings(SIGNINS_ON); }, reasons: ["mail_not_working", "mail_not_working"] },
      Strict: { set: async () => { await seedParentSettings({ ...SIGNINS_ON, level: "strict" }); await seedWorkingMail(); }, reasons: ["strict_no_setup", "strict_no_factor"] },
    };
    for (const [name, c] of Object.entries(cases)) {
      await resetDb(); outbox.length = 0;
      await c.set();
      await seedEveryone();
      expect(await ask("ana@example.com"), name).toEqual(ANSWER);
      expect(await ask("ben@example.com"), name).toEqual(ANSWER);
        expect(outbox, name).toEqual([]);
      expect(await db.select().from(parentSigninToken), name).toEqual([]);
      expect((await reasons()).map((r) => r.reason), name).toEqual(c.reasons);
    }
  });

  it("answers anything that isn't an address of a sane length, uncounted and unrecorded", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    for (const sent of [null, 7, { email: "ana@example.com" }, ["ana@example.com"], `${"a".repeat(310)}@example.com`]) expect(await ask(sent)).toEqual(ANSWER);
    expect(outbox).toEqual([]);
    expect(await asked()).toEqual([]);
    expect(await db.select().from(rateLimitEvent)).toEqual([]);
  });

  it("asking again replaces the unused link", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect((await audits("parent.password.link_made")).map((r) => (r.after as { replaced: number }).replaced)).toEqual([0, 1]);
    expect(await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, noPassword.id))).toHaveLength(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    expect(await linkVerdict("setup", linkIn(outbox[1]!)![2])).toMatchObject({ ok: true });
  });

  it("a send that fails deletes the link it made, and says so", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    sender.mode = "fails";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(async () => expect((await reasons()).map((r) => r.reason)).toEqual([undefined, "mail_failed"]));
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect((await asked()).at(-1)).toMatchObject({ actorId: noPassword.id, targetId: noPassword.id, after: { outcome: "none", reason: "mail_failed", purpose: "setup", linksDeleted: 1 } });
    // The failed send is audited by the mail module, with the address and its error, never the body (and so never the token).
    const [failed] = await audits("mail.failed");
    expect(failed!.after).toMatchObject({ purpose: "password_setup", to: "ana@example.com" });
    expect(JSON.stringify(failed)).not.toContain("/sign-in/set-up/");
  });

  it("answers at once when the send never finishes", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    sender.mode = "hangs";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(await db.select().from(parentSigninToken)).toHaveLength(1);
  });

  it("mails nothing on the fourth ask for one address in a window or the 61st from one IP address; with no address the IP limit is skipped", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    for (let i = 0; i < RATE_LIMITS.password_ask_email.max; i++) expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(3));
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(outbox).toHaveLength(3);
    // Over a limit, one row per full window, naming no person.
    const over = (await asked()).filter((r) => (r.after as { reason?: string }).reason === "rate_limited");
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ actorId: null, actorLabel: null, targetId: null, after: { outcome: "none", reason: "rate_limited", limit: "email" } });
    // Counted under the address's keyed hash, never the address.
    const subjects = (await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_ask_email"))).map((r) => r.subject);
    expect(new Set(subjects)).toEqual(new Set([hashAskedAddress("ana@example.com")]));

    for (let i = (await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_ask_ip"))).length; i < RATE_LIMITS.password_ask_ip.max; i++) {
      await takeRateLimit("password_ask_ip", IP);
    }
    expect(await ask("ben@example.com")).toEqual(ANSWER);
    expect(outbox.filter((m) => m.to === "ben@example.com")).toEqual([]);
    expect((await asked()).at(-1)).toMatchObject({ targetId: null, after: { outcome: "none", reason: "rate_limited", limit: "ip" } });
    fromIp("");
    expect(await ask("ben@example.com")).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox.filter((m) => m.to === "ben@example.com")).toHaveLength(1));
  }, 60_000);

  it("no audit row and no rate-limit count holds an address nobody holds", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    for (const email of OUTSIDERS) await ask(email);
    const rows = JSON.stringify(await db.select().from(auditLog));
    const limits = (await db.select().from(rateLimitEvent)).map((r) => r.subject);
    for (const email of OUTSIDERS) {
      expect(rows).not.toContain(email);
      expect(limits).not.toContain(email);
      expect(limits).toContain(hashAskedAddress(email));
    }
  });
});

describe("the page", () => {
  beforeEach(async () => { await resetDb(); fromIp(IP); });

  const written = async () => ({ audit: (await db.select().from(auditLog)).length, limits: (await db.select().from(rateLimitEvent)).length,
    links: (await db.select().from(parentSigninToken)).length, settings: JSON.stringify(await db.select().from(setting).orderBy(setting.key)) });

  it("shows one email field when ready, writes nothing when opened, and /sign-in links to it", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    const before = await written();
    const html = await renderPage(RequestPage);
    expect(await written()).toEqual(before);
    expect(html).toContain(PASSWORD_COPY.askTitle);
    expect(html).toContain('type="email"');
    expect(html).toContain('autocomplete="email"');
    expect(html).not.toContain(PASSWORD_COPY.askStrict.replaceAll("'", "&#x27;"));
    expect(html).toContain('href="/sign-in"');
    expect(await renderPage(SignInPage)).toContain('href="/sign-in/password"');
  });

  it("under Strict, says to ask the club", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" }); await seedWorkingMail();
    expect(await renderPage(RequestPage)).toContain(PASSWORD_COPY.askStrict.replaceAll("'", "&#x27;"));
  });

  it("shows no form while sign-ins are off, nor /sign-in a link to it", async () => {
    await seedWorkingMail();
    const html = await renderPage(RequestPage);
    expect(html).toContain(SIGNIN_UNAVAILABLE.replaceAll("'", "&#x27;"));
    expect(html).not.toContain('type="email"');
    expect(await renderPage(SignInPage)).not.toContain('href="/sign-in/password"');
  });
});
