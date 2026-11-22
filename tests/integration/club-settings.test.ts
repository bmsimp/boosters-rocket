import { describe, it, expect, beforeEach } from "vitest";
import { calendarDayIn, clubToday, getClubSettings, isTimeZone, saveClubSettings, timeZoneChoices } from "@/lib/settings/club";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const actor = { door: "staff" as const, id: "s1", label: "Pat" };

describe("club settings", () => {
  beforeEach(resetDb);

  it("has neutral defaults before setup", async () => {
    expect(await getClubSettings()).toEqual({ name: "Boosters Rocket", shortName: "BR", color: "#1e1b4b", treasurerEmail: null, timeZone: "UTC", storedColorValid: true });
  });

  it("saves, normalizes the color, and audits before/after", async () => {
    const r = await saveClubSettings({ name: " FZN Band Boosters ", shortName: "FZN", color: "#F2C200", treasurerEmail: "treasurer@fznband.example" }, actor, null);
    expect(r).toEqual({ ok: true });
    expect(await getClubSettings()).toMatchObject({ name: "FZN Band Boosters", color: "#f2c200" });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "settings.club.save", permission: "Settings.Club.ReadWrite" });
  });

  it("falls back to the default color and flags it when the stored color is invalid", async () => {
    await db.insert(setting).values({ key: "club", value: { name: "Odd Club", shortName: "OC", color: "#000;}body{display:none", treasurerEmail: null } });
    const s = await getClubSettings();
    expect(s.storedColorValid).toBe(false);
    expect(s.color).toBe("#1e1b4b");
    expect(s.name).toBe("Odd Club");
  });

  it("flags a stored color of the wrong type", async () => {
    await db.insert(setting).values({ key: "club", value: { color: 42 } });
    expect(await getClubSettings()).toMatchObject({ color: "#1e1b4b", storedColorValid: false });
  });

  it("normalizes a valid stored color and reports it valid", async () => {
    await db.insert(setting).values({ key: "club", value: { color: "#F2C200" } });
    expect(await getClubSettings()).toMatchObject({ color: "#f2c200", storedColorValid: true });
  });

  it("keeps the club's time zone: UTC until one is chosen, kept by a save that doesn't name one, and audited when it changes", async () => {
    const base = { name: "Club", shortName: "CL", color: "#5b2a86", treasurerEmail: null };
    expect(await saveClubSettings(base, actor, null)).toEqual({ ok: true });
    expect((await getClubSettings()).timeZone).toBe("UTC");
    expect(await saveClubSettings({ ...base, timeZone: "America/Chicago" }, actor, null)).toEqual({ ok: true });
    expect((await getClubSettings()).timeZone).toBe("America/Chicago");
    expect(await saveClubSettings(base, actor, null)).toEqual({ ok: true });
    expect((await getClubSettings()).timeZone).toBe("America/Chicago");
    const rows = await db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows[1]).toMatchObject({ before: { timeZone: "UTC" }, after: { timeZone: "America/Chicago" } });
    expect(rows[2]).toMatchObject({ before: { timeZone: "America/Chicago" }, after: { timeZone: "America/Chicago" } });
  });

  it.each(["Mars/Olympus_Mons", "+05:00", "Chicago", "", "America/Chicago; drop table setting", "x".repeat(65)])("refuses the time zone %j", async (timeZone) => {
    const r = await saveClubSettings({ name: "Club", shortName: "CL", color: "#5b2a86", treasurerEmail: null, timeZone }, actor, null);
    expect(r).toEqual({ ok: false, errors: ["Choose a time zone from the list."] });
    expect(isTimeZone(timeZone)).toBe(false);
  });

  it("falls back to UTC for a stored zone the server can't use", async () => {
    await db.insert(setting).values({ key: "club", value: { timeZone: "Mars/Olympus_Mons" } });
    expect((await getClubSettings()).timeZone).toBe("UTC");
    await db.update(setting).set({ value: { timeZone: 7 } });
    expect((await getClubSettings()).timeZone).toBe("UTC");
  });

  it("says which day it is for the club, not for the server or the viewer", async () => {
    // 03:30 UTC on Nov 15 is still the evening of Nov 14 in Chicago, and already the afternoon of Nov 15 in Auckland.
    const at = new Date("2026-11-15T03:30:00Z");
    expect(calendarDayIn("UTC", at)).toBe("2026-11-15");
    expect(calendarDayIn("America/Chicago", at)).toBe("2026-11-14");
    expect(calendarDayIn("Pacific/Auckland", at)).toBe("2026-11-15");
    expect(calendarDayIn("Pacific/Auckland", new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-01");
    expect(await clubToday(at)).toBe("2026-11-15");
    await saveClubSettings({ name: "Club", shortName: "CL", color: "#5b2a86", treasurerEmail: null, timeZone: "America/Chicago" }, actor, null);
    expect(await clubToday(at)).toBe("2026-11-14");
    expect(await clubToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("offers UTC first, then the server's zones, and every one of them is accepted", () => {
    const zones = timeZoneChoices();
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("America/Chicago");
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.filter((z) => !isTimeZone(z))).toEqual([]);
    expect(timeZoneChoices("US/Central").at(-1)).toBe("US/Central");
  });

  it.each([
    [{ color: "red" }, "Color"],
    [{ color: "#000;}body{display:none" }, "Color"],
    [{ name: "" }, "Club name"],
    [{ shortName: "TOOLONG" }, "Short name"],
    [{ treasurerEmail: "nope" }, "Treasurer email"],
  ])("rejects %j", async (patch, field) => {
    const r = await saveClubSettings({ name: "Club", shortName: "CL", color: "#5b2a86", treasurerEmail: null, ...patch }, actor, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(field);
  });
});
