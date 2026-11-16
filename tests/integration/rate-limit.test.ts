import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";
import { RATE_LIMITS, takeRateLimit } from "@/lib/parents/rate-limit";
import { resetDb } from "../helpers/db";

describe("database rate limits", () => {
  beforeEach(resetDb);

  it("allows the limit within 15 minutes, refuses the next, and counts each subject on its own", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe("taken");
    expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe("first_refusal");
    expect(await takeRateLimit("code_send_email", "ben@example.com", t)).toBe("taken");
    expect(await takeRateLimit("code_send_ip", "ana@example.com", t)).toBe("taken");
  });

  it("is a sliding window, and drops events older than it", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) await takeRateLimit("code_send_email", "ana@example.com", t);
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 14 * 60_000))).toBe("first_refusal");
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 15 * 60_000 + 1))).toBe("taken");
    expect(await db.select().from(rateLimitEvent)).toHaveLength(1);
  });

  it("says a refusal is the first of its window only once, and refusals don't add rows or extend the window", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    const plus = (ms: number) => new Date(t.getTime() + ms);
    for (let i = 0; i < 3; i++) await takeRateLimit("code_send_email", "ana@example.com", plus(i * 60_000));
    const refusals = [];
    for (let i = 0; i < 5; i++) refusals.push(await takeRateLimit("code_send_email", "ana@example.com", plus(5 * 60_000 + i)));
    expect(refusals).toEqual(["first_refusal", "refused", "refused", "refused", "refused"]);
    expect(await db.select().from(rateLimitEvent)).toHaveLength(3);
    expect(await takeRateLimit("code_send_email", "ben@example.com", plus(5 * 60_000))).toBe("taken"); // its own subject
    // The window frees on the first event's schedule, not pushed out by the refusals; the next full window is new.
    expect(await takeRateLimit("code_send_email", "ana@example.com", plus(15 * 60_000 + 1))).toBe("taken");
    expect(await takeRateLimit("code_send_email", "ana@example.com", plus(15 * 60_000 + 2))).toBe("first_refusal");
    expect(await takeRateLimit("code_send_email", "ana@example.com", plus(15 * 60_000 + 3))).toBe("refused");
  });

  it("holds under a burst of parallel requests", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    const got = await Promise.all(Array.from({ length: 75 }, () => takeRateLimit("code_send_ip", "203.0.113.9", t)));
    expect(got.filter((r) => r === "taken")).toHaveLength(60);
    expect(got.filter((r) => r === "first_refusal")).toHaveLength(1);
  }, 30_000);

  it("guards against guessing per address, and only against a flood per IP address", () => {
    // 3 codes to one address; 60 requests and 180 checks from one IP address, which a school's shared Wi-Fi needs on a
    // registration night (spec §1 Rate limits). All in 15 minutes.
    const window = { windowMs: 15 * 60 * 1000 };
    const { contact_save_parent, contact_open_parent, form_open_parent, email_request_parent, email_confirm_parent, ...signIn } = RATE_LIMITS;
    expect(signIn).toEqual({ code_send_email: { max: 3, ...window }, code_send_ip: { max: 60, ...window }, code_check_ip: { max: 180, ...window } });
    // A parent's own phone and address (src/lib/parents/contact-edits.ts), counted per person: a handful of saves an
    // hour, each a write to the club's QuickBooks, and the reads the edit page makes as it opens.
    expect(contact_save_parent).toEqual({ max: 6, windowMs: 60 * 60 * 1000 });
    expect(contact_open_parent).toEqual({ max: 30, ...window });
    // Opening a form to sign and checking how it stands (src/lib/forms/signing.ts), counted per person: each asks the
    // club's Documenso once. A family signing a dozen forms in a sitting stays well under it.
    expect(form_open_parent).toEqual({ max: 120, ...window });
    // A parent's change of their own sign-in address (src/lib/parents/email-change.ts), counted per person: each ask
    // mails two addresses, and each confirmation reads, and may write, the club's QuickBooks.
    expect(email_request_parent).toEqual({ max: 5, windowMs: 60 * 60 * 1000 });
    expect(email_confirm_parent).toEqual({ max: 10, windowMs: 60 * 60 * 1000 });
  });
});
