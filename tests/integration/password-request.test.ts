import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
/**
 * How the mail sender behaves: as a working one, failing every send, never finishing one, or waiting until the test
 * lets it go (`release`, set while it waits). With `brandThrows`, the mail is never even written: reading the club's
 * name for it throws, outside the sender.
 */
const sender = vi.hoisted(() => ({ mode: "works" as "works" | "fails" | "hangs" | "waits" | "brandThrows", release: null as null | (() => void) }));
vi.mock("@/lib/mail/senders", () => ({
  SMTP_PASSWORD_AAD: "mail:smtp-password",
  buildSender: async () => async (m: Msg) => {
    if (sender.mode === "fails") throw new Error("the mail server said no");
    if (sender.mode === "hangs") await new Promise(() => undefined);
    if (sender.mode === "waits") await new Promise<void>((resolve) => { sender.release = resolve; });
    outbox.push(m);
  },
}));
vi.mock("@/lib/mail/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mail/send")>();
  return { ...actual, currentBrand: async () => {
    if (sender.mode === "brandThrows") throw new Error("the settings could not be read");
    return actual.currentBrand();
  } };
});
/**
 * Putting a held link in place fails the next `fails` times, with the Postgres code `code` when one is set (40P01, a
 * deadlock, is tried once more; anything else is not). The transaction it runs in rolls back, as a real failure's does.
 */
const putting = vi.hoisted(() => ({ fails: 0, code: undefined as string | undefined }));
vi.mock("@/lib/parents/signin-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/parents/signin-links")>();
  return { ...actual, putHeldLinkInPlace: async (...args: Parameters<typeof actual.putHeldLinkInPlace>) => {
    if (putting.fails > 0) { putting.fails--; throw Object.assign(new Error("the database said no"), { code: putting.code }); }
    return actual.putHeldLinkInPlace(...args);
  } };
});
// A reset made in a test asks no outside service: the breach check says it has seen no such password.
vi.mock("@/lib/parents/breach-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/parents/breach-check")>()), checkBreach: async () => ({ outcome: "not_found" as const }),
}));
import { fromIp, renderPage } from "../helpers/signed-in";

import { eq, isNull } from "drizzle-orm";
import { RESEND_AFTER_MS } from "@/lib/parents/signin-codes";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthUser, parentSigninToken, rateLimitEvent, setting } from "@/lib/db/schema";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { hashAskedAddress } from "@/lib/parents/password-request";
import { takeRateLimit, RATE_LIMITS } from "@/lib/parents/rate-limit";
import { linkVerdict } from "@/lib/parents/signin-links";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import { removeGuardian } from "@/lib/parents/guardians";
import { choosePasswordFromLink } from "@/lib/parents/password-set";
import { setSignins } from "@/lib/parents/switches";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { askPasswordLinkAction } from "@/app/sign-in/password-actions";
import RequestPage from "@/app/sign-in/password/page";
import SignInPage from "@/app/sign-in/page";
import { resetDb, seedGuardianInFamily, seedParent, seedStaff, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { mintLink, seedPassword } from "../helpers/signin-links";
import { seedAuthenticator } from "../helpers/authenticator";
import { seedPasskey } from "../helpers/passkey";

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
/** What became of each held link that was not put in place: the reasons of the `parent.password.link_not_sent` rows. */
const notSent = async () => (await audits("parent.password.link_not_sent")).map((r) => (r.after as { reason: string }).reason);
/** The link a mail holds, and the token in it. */
const linkIn = (m: Msg) => /\/sign-in\/(set-up|reset)\/([A-Za-z0-9_-]{43})/.exec(m.text);
/**
 * Until `n` links have been put in place. A mailed link works only once its mail has been handed over and the portal
 * has then put it in place, a moment after the mail reaches the outbox.
 */
const untilPutInPlace = (n: number) => vi.waitFor(async () => expect(await audits("parent.password.link_made")).toHaveLength(n));
/** As if the person's links were made longer ago than the resend wait, so the next ask may mail one. */
const pastTheResendWait = () => db.update(parentSigninToken).set({ createdAt: new Date(Date.now() - RESEND_AFTER_MS - 1000) }).where(isNull(parentSigninToken.usedAt));
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
  beforeEach(async () => { await resetDb(); outbox.length = 0; sender.mode = "works"; sender.release = null; putting.fails = 0; putting.code = undefined; fromIp(IP); });

  it("answers the same for every address, mails a set-up link and a reset link to the two it may, and nothing to anyone else", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword, withPassword, blocked, noRow, noAccount } = await seedEveryone();
    const answers = [];
    for (const email of ["ana@example.com", "  BEN@example.com ", ...OUTSIDERS, "cy@example.com", "dee@example.com", "eli@example.com", "not an address"]) {
      answers.push(await ask(email));
    }
    for (const a of answers) expect(a).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    await untilPutInPlace(2);
    expect(outbox.map((m) => m.to).sort()).toEqual(["ana@example.com", "ben@example.com"]);

    const setup = outbox.find((m) => m.to === "ana@example.com")!, reset = outbox.find((m) => m.to === "ben@example.com")!;
    expect(linkIn(setup)![1]).toBe("set-up");
    expect(linkIn(reset)![1]).toBe("reset");
    expect(await linkVerdict("setup", linkIn(setup)![2])).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await linkVerdict("reset", linkIn(reset)![2])).toMatchObject({ ok: true, link: { parentId: withPassword.id } });

    // One row per ask, written when it was decided: against the person when the address is theirs, naming nobody
    // otherwise; a mailed one says which link is on its way.
    const rows = await asked();
    expect(rows).toHaveLength(answers.length);
    const of = (id: string) => rows.find((r) => r.targetId === id)!;
    expect(of(noPassword.id)).toMatchObject({ door: "parent", actorId: noPassword.id, targetType: "parent", ip: IP });
    expect(of(noPassword.id).after).toEqual({ outcome: "setup", link: "on_its_way" });
    expect(of(withPassword.id)).toMatchObject({ actorId: withPassword.id, after: { outcome: "reset", link: "on_its_way" } });
    // Both links were put in place: no row says one wasn't.
    expect(await notSent()).toEqual([]);
    expect(of(blocked.id).after).toEqual({ outcome: "none", reason: "blocked" });
    expect(of(noRow.id).after).toEqual({ outcome: "none", reason: "no_enabled_guardian" });
    expect(of(noAccount.id).after).toEqual({ outcome: "none", reason: "no_sign_in_account" });
    const nobody = rows.filter((r) => r.targetId === null);
    expect(nobody.map((r) => r.after)).toEqual([{ outcome: "none", reason: "unknown_email" }, { outcome: "none", reason: "unknown_email" }, { outcome: "none", reason: "not_an_address" }]);
    for (const r of nobody) expect(r).toMatchObject({ actorId: null, actorLabel: null, targetType: null });
    // The mint's own row, as SI-2 wrote it, for each link made.
    expect((await audits("parent.password.link_made")).map((r) => (r.after as { purpose: string }).purpose).sort()).toEqual(["reset", "setup"]);
    // The tokens are in the mails alone: in no audit row (reset_asked, link_made or any other) and no rate-limit count.
    const everyRow = JSON.stringify(await db.select().from(auditLog));
    const subjects = (await db.select().from(rateLimitEvent)).map((r) => r.subject);
    for (const m of [setup, reset]) {
      const token = linkIn(m)![2]!;
      expect(everyRow).not.toContain(token);
      expect(subjects).not.toContain(token);
    }
    expect(everyRow).not.toContain("/sign-in/set-up/");
    expect(everyRow).not.toContain("/sign-in/reset/");
  });

  it("the mailed link opens its page with the form", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
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

  it("under Strict, mails a reset to a guardian with an authenticator app in force, and still none to one whose set-up is unfinished (slice SI-6a)", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" }); await seedWorkingMail();
    const { withPassword } = await seedEveryone();
    const fay = await seedParent({ name: "Fay", email: "fay@example.com" });
    await seedGuardianInFamily({ parentId: fay.id, familyQboId: "F1" });
    await seedPassword(fay.authUserId, "a phrase Fay chose some time ago");
    await seedAuthenticator(withPassword.id);
    await seedAuthenticator(fay.id, { confirmed: false });
    expect(await ask("ben@example.com")).toEqual(ANSWER);
    expect(await ask("fay@example.com")).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    expect(outbox[0]!.to).toBe("ben@example.com");
    expect(linkIn(outbox[0]!)![1]).toBe("reset");
    expect(await reasons()).toEqual([{ outcome: "reset", link: "on_its_way" }, { outcome: "none", reason: "strict_no_factor" }]);
  });

  it("under Strict, mails a reset to a guardian with a passkey and no app (slice SI-7a)", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" }); await seedWorkingMail();
    const { withPassword } = await seedEveryone();
    await seedPasskey(withPassword.id);
    expect(await ask("ben@example.com")).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    expect(outbox[0]!.to).toBe("ben@example.com");
    expect(linkIn(outbox[0]!)![1]).toBe("reset");
    expect(await reasons()).toEqual([{ outcome: "reset", link: "on_its_way" }]);
  });

  it("answers anything that isn't an address of a sane length, uncounted and unrecorded", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    for (const sent of [null, 7, { email: "ana@example.com" }, ["ana@example.com"], `${"a".repeat(310)}@example.com`]) expect(await ask(sent)).toEqual(ANSWER);
    expect(outbox).toEqual([]);
    expect(await asked()).toEqual([]);
    expect(await db.select().from(rateLimitEvent)).toEqual([]);
  });

  it("asking again once the resend wait has passed replaces the unused link", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    await pastTheResendWait();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    await untilPutInPlace(2);
    expect((await audits("parent.password.link_made")).map((r) => (r.after as { replaced: number }).replaced)).toEqual([0, 1]);
    expect(await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, noPassword.id))).toHaveLength(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    expect(await linkVerdict("setup", linkIn(outbox[1]!)![2])).toMatchObject({ ok: true });
  });

  it("within the resend wait, a second ask mails and makes nothing, and the link already sent keeps working", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(outbox).toHaveLength(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: true });
    expect(await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, noPassword.id))).toHaveLength(1);
    expect((await asked()).at(-1)).toMatchObject({ targetId: noPassword.id, after: { outcome: "none", reason: "resend_wait", purpose: "setup" } });
    // It counted against the limit per address all the same.
    expect(await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.subject, hashAskedAddress("ana@example.com")))).toHaveLength(2);
  });

  it("a second ask while the first link's mail is still on its way mails nothing either", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    sender.mode = "waits";
    await ask("ana@example.com");
    await vi.waitFor(() => expect(sender.release).not.toBeNull());
    await ask("ana@example.com");
    // The first ask's row, written with its hold, then the second's.
    expect((await reasons()).map((r) => r.reason ?? r.outcome)).toEqual(["setup", "resend_wait"]);
    sender.release!();
    await untilPutInPlace(1);
    expect(outbox).toHaveLength(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: true });
  });

  it("a send that fails removes the new link, keeps the one the person already had, and says so once", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    const earlier = linkIn(outbox[0]!)![2]!;
    await pastTheResendWait();
    sender.mode = "fails";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(async () => expect(await notSent()).toEqual(["mail_failed"]));
    // The earlier link, already in the mailbox, still works: the ask that failed to reach the person took nothing.
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await db.select().from(parentSigninToken)).toHaveLength(1);
    expect(await audits("parent.password.link_made")).toHaveLength(1);
    // Each ask has its one row, written when it was decided; what became of the second link is a row of its own.
    expect((await reasons()).map((r) => r.outcome)).toEqual(["setup", "setup"]);
    expect((await audits("parent.password.link_not_sent"))[0]).toMatchObject({ actorId: noPassword.id, targetType: "parent", targetId: noPassword.id,
      after: { purpose: "setup", reason: "mail_failed" }, ip: IP });
    // The failed send is audited by the mail module, with the address and its error, never the body (and so never the token).
    const [failed] = await audits("mail.failed");
    expect(failed!.after).toMatchObject({ purpose: "password_setup", to: "ana@example.com" });
    expect(JSON.stringify(failed)).not.toContain("/sign-in/set-up/");
  });

  it("when the mail can't even be written, the new link goes, the earlier one stays, and one row says the mail failed", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    await ask("ana@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    const earlier = linkIn(outbox[0]!)![2]!;
    await pastTheResendWait();
    sender.mode = "brandThrows";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(async () => expect(await notSent()).toEqual(["mail_failed"]));
    expect(outbox).toHaveLength(1);
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await db.select().from(parentSigninToken)).toHaveLength(1);
  });

  it("a person blocked while their link's mail is on its way gets no live link from it", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    sender.mode = "waits";
    await ask("ana@example.com");
    await vi.waitFor(() => expect(sender.release).not.toBeNull());
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, noPassword.id));
    sender.release!();
    await vi.waitFor(async () => expect(await notSent()).toEqual(["blocked"]));
    expect((await reasons()).map((r) => r.outcome)).toEqual(["setup"]);
    expect(outbox).toHaveLength(1);
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect(await audits("parent.password.link_made")).toEqual([]);
    await db.update(parent).set({ blocked: false }).where(eq(parent.id, noPassword.id));
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
  });

  // An end of the person's sign-in deletes the held link with their unused ones, so letting them in again before the
  // mail is handed over never brings a link from before the end to life.
  const STAFF = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
  type Seeded = Awaited<ReturnType<typeof seedEveryone>>["noPassword"];
  const ENDS: Record<string, (p: Seeded) => Promise<void>> = {
    "blocked and unblocked": async (p) => {
      expect(await blockPerson(p.id, "Custody order on file.", STAFF)).toMatchObject({ ok: true });
      expect((await audits("parent.block")).at(-1)!.after).toMatchObject({ linksDeleted: 1 });
      expect(await unblockPerson(p.id, STAFF)).toEqual({ ok: true, changed: true });
    },
    "with sign-ins switched off and on": async () => {
      expect(await setSignins(false, STAFF)).toEqual({ ok: true });
      expect(await setSignins(true, STAFF)).toEqual({ ok: true });
    },
    // Closing the person's last open membership (the lead's choice 10), then the row opened again as it was. Its family
    // has no link, so the row is opened by hand, as a reinstate opens it.
    "removed from their last family and let back in": async (p) => {
      expect(await removeGuardian(p.row.id, "Moved away.", STAFF)).toMatchObject({ ok: true });
      expect((await audits("parent.access.ended")).at(-1)!.after).toMatchObject({ linksDeleted: 1 });
      await db.update(guardian).set({ status: p.row.status, disabledReason: null }).where(eq(guardian.id, p.row.id));
    },
  };
  for (const [how, end] of Object.entries(ENDS)) {
    it(`a person ${how} while their link's mail is on its way gets no live link from it`, async () => {
      await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
      const { noPassword } = await seedEveryone();
      sender.mode = "waits";
      await ask("ana@example.com");
      await vi.waitFor(() => expect(sender.release).not.toBeNull());
      await end(noPassword);
      expect(await db.select().from(parentSigninToken)).toEqual([]);
      sender.release!();
      await vi.waitFor(async () => expect(await notSent()).toEqual(["changed_while_mailing"]));
      expect(outbox).toHaveLength(1);
      expect(await db.select().from(parentSigninToken)).toEqual([]);
      expect(await audits("parent.password.link_made")).toEqual([]);
      expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    });
  }

  it("a link made while the asked-for one's mail is on its way wins: the held one is never put in place", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    sender.mode = "waits";
    await ask("ana@example.com");
    await vi.waitFor(() => expect(sender.release).not.toBeNull());
    // As the welcome (SI-4) or the staff reset (SI-9) will make one: it replaces the held link.
    const minted = await mintLink(noPassword.id, "setup");
    expect((await audits("parent.password.link_made")).map((r) => r.after)).toEqual([expect.objectContaining({ purpose: "setup", replaced: 1, heldReplaced: [expect.any(String)] })]);
    sender.release!();
    await vi.waitFor(async () => expect(await notSent()).toEqual(["superseded"]));
    expect(outbox).toHaveLength(1);
    expect(await linkVerdict("setup", minted)).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    expect(await db.select().from(parentSigninToken)).toHaveLength(1);
    // Only the mint's own row: the held link was never put in place.
    expect(await audits("parent.password.link_made")).toHaveLength(1);
  });

  // A link the person asked for again after an end is no newer link that replaced the first: the end removed it, and
  // its row says so whichever of the two mails is handed over first.
  for (const firstHandedOver of ["the first ask's", "the second ask's"] as const) {
    it(`a person who asks again after an end, ${firstHandedOver} mail handed over first: the first link's row says it changed while mailing`, async () => {
      await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
      const { noPassword } = await seedEveryone();
      sender.mode = "waits";
      await ask("ana@example.com");
      await vi.waitFor(() => expect(sender.release).not.toBeNull());
      const releaseFirst = sender.release!;
      sender.release = null;
      await ENDS["blocked and unblocked"]!(noPassword);
      // Nothing live and nothing on its way any more, so the second ask holds a link of its own and mails it.
      await ask("ana@example.com");
      await vi.waitFor(() => expect(sender.release).not.toBeNull());
      const releaseSecond = sender.release!;
      expect((await reasons()).map((r) => r.outcome)).toEqual(["setup", "setup"]);
      if (firstHandedOver === "the first ask's") {
        releaseFirst();
        await vi.waitFor(async () => expect(await notSent()).toEqual(["changed_while_mailing"]));
        releaseSecond();
        await untilPutInPlace(1);
      } else {
        releaseSecond();
        await untilPutInPlace(1);
        releaseFirst();
        await vi.waitFor(async () => expect(await notSent()).toEqual(["changed_while_mailing"]));
      }
      expect(outbox).toHaveLength(2);
      // The second ask's link is the one live link; the first one's mail holds a link that works for nobody.
      const live = [];
      for (const m of outbox) if ((await linkVerdict("setup", linkIn(m)![2]!)).ok) live.push(m);
      expect(live).toHaveLength(1);
      expect(await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, noPassword.id))).toHaveLength(1);
      expect(await audits("parent.password.link_made")).toHaveLength(1);
    });
  }

  it("a password reset ends a reset link whose mail is on its way", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { withPassword } = await seedEveryone();
    await ask("ben@example.com");
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    await untilPutInPlace(1);
    const earlier = linkIn(outbox[0]!)![2]!;
    await pastTheResendWait();
    sender.mode = "waits";
    await ask("ben@example.com");
    await vi.waitFor(() => expect(sender.release).not.toBeNull());
    // Ben resets his password with the link he already had, while the second one's mail is on its way.
    const phrase = "a brand new phrase for Ben, long enough";
    expect(await choosePasswordFromLink({ purpose: "reset", token: earlier, password: phrase, again: phrase }, { ip: IP })).toMatchObject({ ok: true });
    expect((await audits("parent.password.set")).map((r) => r.after)).toEqual([expect.objectContaining({ purpose: "reset", linksDeleted: 1 })]);
    sender.release!();
    await vi.waitFor(async () => expect(await notSent()).toEqual(["changed_while_mailing"]));
    expect(outbox).toHaveLength(2);
    expect(await linkVerdict("reset", linkIn(outbox[1]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    // No live link: the one row left is the link the reset spent.
    const rows = await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, withPassword.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).not.toBeNull();
    expect(await audits("parent.password.link_made")).toHaveLength(1);
  });

  it("a link whose mail went but which can't then be put in place goes, and its row says so, not that the mail failed", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    putting.fails = 1;
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(async () => expect(await notSent()).toEqual(["not_put_in_place"]));
    expect(outbox).toHaveLength(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: false, reason: "unknown" });
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect(await audits("parent.password.link_made")).toEqual([]);
    expect(await audits("mail.failed")).toEqual([]);
    expect((await audits("parent.password.link_not_sent"))[0]).toMatchObject({ targetId: noPassword.id, after: { purpose: "setup", reason: "not_put_in_place" } });
    expect((await reasons()).map((r) => r.outcome)).toEqual(["setup"]);
  });

  it("a putting in place that a deadlock ended is tried once more, and the link works", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    putting.fails = 1; putting.code = "40P01";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    await untilPutInPlace(1);
    expect(await linkVerdict("setup", linkIn(outbox[0]!)![2])).toMatchObject({ ok: true, link: { parentId: noPassword.id } });
    expect(await notSent()).toEqual([]);
  });

  it("answers at once when the send never finishes, the ask's one row written already", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    const { noPassword } = await seedEveryone();
    sender.mode = "hangs";
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(await db.select().from(parentSigninToken)).toHaveLength(1);
    // Written with the hold, in its transaction: an ask whose delivery never settles still has its row, and no row after it.
    expect((await asked()).map((r) => ({ targetId: r.targetId, after: r.after }))).toEqual([{ targetId: noPassword.id, after: { outcome: "setup", link: "on_its_way" } }]);
    expect(await notSent()).toEqual([]);
    expect(await audits("parent.password.link_made")).toEqual([]);
  });

  it("mails nothing on the fourth ask for one address in a window or the 61st from one IP address; with no address the IP limit is skipped", async () => {
    await seedParentSettings(SIGNINS_ON); await seedWorkingMail();
    await seedEveryone();
    // The first ask mails a link; the two after it, within the resend wait, mail nothing but count all the same.
    for (let i = 0; i < RATE_LIMITS.password_ask_email.max; i++) expect(await ask("ana@example.com")).toEqual(ANSWER);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect((await reasons()).filter((r) => r.reason === "resend_wait")).toHaveLength(RATE_LIMITS.password_ask_email.max - 1);
    await untilPutInPlace(1);
    await pastTheResendWait();
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(await ask("ana@example.com")).toEqual(ANSWER);
    expect(outbox).toHaveLength(1);
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
    // React's server render writes the prop's own name (`autoComplete=`); HTML reads attribute names in any case.
    expect(html).toMatch(/autocomplete="email"/i);
    expect(html).not.toContain(PASSWORD_COPY.askStrict.replaceAll("'", "&#x27;"));
    expect(html).toContain(PASSWORD_COPY.askLede.replaceAll("'", "&#x27;"));
    expect(html).toContain('href="/sign-in"');
    expect(await renderPage(SignInPage)).toContain('href="/sign-in/password"');
  });

  it("under Strict, promises a link only to a holder of a passkey or an app, and says to ask the club", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" }); await seedWorkingMail();
    const html = await renderPage(RequestPage);
    expect(html).toContain(PASSWORD_COPY.askStrict.replaceAll("'", "&#x27;"));
    expect(html).toContain(PASSWORD_COPY.askLedeStrict.replaceAll("'", "&#x27;"));
    expect(html).not.toContain(PASSWORD_COPY.askLede.replaceAll("'", "&#x27;"));
  });

  it("shows no form while sign-ins are off, nor /sign-in a link to it", async () => {
    await seedWorkingMail();
    const html = await renderPage(RequestPage);
    expect(html).toContain(SIGNIN_UNAVAILABLE.replaceAll("'", "&#x27;"));
    expect(html).not.toContain('type="email"');
    expect(await renderPage(SignInPage)).not.toContain('href="/sign-in/password"');
  });
});
