import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { resetDb } from "../helpers/db";

describe("database rate limits", () => {
  beforeEach(resetDb);

  it("allows the limit within 15 minutes, refuses the next, and counts each subject on its own", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe(true);
    expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe(false);
    expect(await takeRateLimit("code_send_email", "ben@example.com", t)).toBe(true);
    expect(await takeRateLimit("code_send_ip", "ana@example.com", t)).toBe(true);
  });

  it("is a sliding window, and drops events older than it", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) await takeRateLimit("code_send_email", "ana@example.com", t);
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 14 * 60_000))).toBe(false);
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 15 * 60_000 + 1))).toBe(true);
    expect(await db.select().from(rateLimitEvent)).toHaveLength(1);
  });

  it("holds under a burst of parallel requests", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    const got = await Promise.all(Array.from({ length: 25 }, () => takeRateLimit("code_send_ip", "203.0.113.9", t)));
    expect(got.filter(Boolean)).toHaveLength(10);
  });
});
