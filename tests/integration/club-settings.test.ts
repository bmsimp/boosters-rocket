import { describe, it, expect, beforeEach } from "vitest";
import { getClubSettings, saveClubSettings } from "@/lib/settings/club";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const actor = { door: "staff" as const, id: "s1", label: "Pat" };

describe("club settings", () => {
  beforeEach(resetDb);

  it("has neutral defaults before setup", async () => {
    expect(await getClubSettings()).toEqual({ name: "Booster Rocket", shortName: "BR", color: "#5b2a86", treasurerEmail: null, storedColorValid: true });
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
    expect(s.color).toBe("#5b2a86");
    expect(s.name).toBe("Odd Club");
  });

  it("flags a stored color of the wrong type", async () => {
    await db.insert(setting).values({ key: "club", value: { color: 42 } });
    expect(await getClubSettings()).toMatchObject({ color: "#5b2a86", storedColorValid: false });
  });

  it("normalizes a valid stored color and reports it valid", async () => {
    await db.insert(setting).values({ key: "club", value: { color: "#F2C200" } });
    expect(await getClubSettings()).toMatchObject({ color: "#f2c200", storedColorValid: true });
  });

  it("still reads a row saved under the old colour key, and writes color from now on", async () => {
    await db.insert(setting).values({ key: "club", value: { name: "Old Row", shortName: "OR", colour: "#F2C200", treasurerEmail: null } });
    const read = await getClubSettings();
    expect(read).toMatchObject({ name: "Old Row", color: "#f2c200", storedColorValid: true });
    expect(read).not.toHaveProperty("colour");
    await saveClubSettings({ name: "Old Row", shortName: "OR", color: "#112233", treasurerEmail: null }, actor, null);
    const [row] = await db.select().from(setting);
    expect(row?.value).toEqual({ name: "Old Row", shortName: "OR", color: "#112233", treasurerEmail: null });
  });

  it("flags an invalid value stored under the old colour key", async () => {
    await db.insert(setting).values({ key: "club", value: { colour: "nope" } });
    expect(await getClubSettings()).toMatchObject({ color: "#5b2a86", storedColorValid: false });
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
