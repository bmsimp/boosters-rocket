import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";
import { takeRateLimit } from "@/lib/parents/rate-limit";
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
    const got = await Promise.all(Array.from({ length: 25 }, () => takeRateLimit("code_send_ip", "203.0.113.9", t)));
    expect(got.filter((r) => r === "taken")).toHaveLength(10);
    expect(got.filter((r) => r === "first_refusal")).toHaveLength(1);
  });
});
