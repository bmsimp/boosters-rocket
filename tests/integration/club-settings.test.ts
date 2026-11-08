import { describe, it, expect, beforeEach } from "vitest";
import { getClubSettings, saveClubSettings } from "@/lib/settings/club";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const actor = { door: "staff" as const, id: "s1", label: "Pat" };

describe("club settings", () => {
  beforeEach(resetDb);

  it("has neutral defaults before setup", async () => {
    expect(await getClubSettings()).toEqual({ name: "Booster Rocket", shortName: "BR", colour: "#5b2a86", treasurerEmail: null, storedColourValid: true });
  });

  it("saves, normalises the colour, and audits before/after", async () => {
    const r = await saveClubSettings({ name: " FZN Band Boosters ", shortName: "FZN", colour: "#F2C200", treasurerEmail: "treasurer@fznband.example" }, actor, null);
    expect(r).toEqual({ ok: true });
    expect(await getClubSettings()).toMatchObject({ name: "FZN Band Boosters", colour: "#f2c200" });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "settings.club.save", permission: "Settings.Club.ReadWrite" });
  });

  it("falls back to the default colour and flags it when the stored colour is invalid", async () => {
    await db.insert(setting).values({ key: "club", value: { name: "Odd Club", shortName: "OC", colour: "#000;}body{display:none", treasurerEmail: null } });
    const s = await getClubSettings();
    expect(s.storedColourValid).toBe(false);
    expect(s.colour).toBe("#5b2a86");
    expect(s.name).toBe("Odd Club");
  });

  it("flags a stored colour of the wrong type", async () => {
    await db.insert(setting).values({ key: "club", value: { colour: 42 } });
    expect(await getClubSettings()).toMatchObject({ colour: "#5b2a86", storedColourValid: false });
  });

  it("normalizes a valid stored colour and reports it valid", async () => {
    await db.insert(setting).values({ key: "club", value: { colour: "#F2C200" } });
    expect(await getClubSettings()).toMatchObject({ colour: "#f2c200", storedColourValid: true });
  });

  it.each([
    [{ colour: "red" }, "Colour"],
    [{ colour: "#000;}body{display:none" }, "Colour"],
    [{ name: "" }, "Club name"],
    [{ shortName: "TOOLONG" }, "Short name"],
    [{ treasurerEmail: "nope" }, "Treasurer email"],
  ])("rejects %j", async (patch, field) => {
    const r = await saveClubSettings({ name: "Club", shortName: "CL", colour: "#5b2a86", treasurerEmail: null, ...patch }, actor, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(field);
  });
});
