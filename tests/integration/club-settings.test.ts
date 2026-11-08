import { describe, it, expect, beforeEach } from "vitest";
import { getClubSettings, saveClubSettings } from "@/lib/settings/club";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const actor = { door: "staff" as const, id: "s1", label: "Pat" };

describe("club settings", () => {
  beforeEach(resetDb);

  it("has neutral defaults before setup", async () => {
    expect(await getClubSettings()).toEqual({ name: "Booster Rocket", shortName: "BR", colour: "#5b2a86", treasurerEmail: null });
  });

  it("saves, normalises the colour, and audits before/after", async () => {
    const r = await saveClubSettings({ name: " FZN Band Boosters ", shortName: "FZN", colour: "#F2C200", treasurerEmail: "treasurer@fznband.example" }, actor, null);
    expect(r).toEqual({ ok: true });
    expect(await getClubSettings()).toMatchObject({ name: "FZN Band Boosters", colour: "#f2c200" });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "settings.club.save", permission: "Settings.Club.ReadWrite" });
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
