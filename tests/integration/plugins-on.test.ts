import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

// requirePluginPage(): Next's answers, as errors a test can see.
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
// Nobody signed in.
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => null, getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }),
  hasStaffSession: async () => false, hasParentSession: async () => false,
}));
vi.mock("@/lib/request", () => ({ requestIp: async () => null }));

import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { accountingOn, pluginOn, pluginsOn, PLUGINS_ON_KEY } from "@/plugins";
import { finishSetup } from "@/lib/setup/state";
import * as guards from "@/lib/guards";
import { resetDb, seedStaff } from "../helpers/db";

// Which plugins are on (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, sections 3 and 6): one setting,
// `plugins.on`, read through pluginOn() and accountingOn(); the migration that turns QuickBooks on where setup is
// finished; finishing setup, which turns it on until setup asks (slice P8); and requirePluginPage().

const store = (value: unknown) => db.insert(setting).values({ key: PLUGINS_ON_KEY, value })
  .onConflictDoUpdate({ target: setting.key, set: { value } });
const stored = async () => (await db.select().from(setting).where(eq(setting.key, PLUGINS_ON_KEY)))[0]?.value;

/** Migration 0061's statement, found by its tag, run as the migrator would run it. */
const migration = () => {
  const file = readdirSync("drizzle").find((f) => f.endsWith("_plugins_on.sql"));
  if (!file) throw new Error("no plugins_on migration");
  return readFileSync(path.join("drizzle", file), "utf8");
};

beforeEach(async () => {
  await resetDb();
  await db.delete(setting).where(eq(setting.key, PLUGINS_ON_KEY));
});

describe("plugins.on", () => {
  it("is none on when nothing is stored: a new installation", async () => {
    expect(await pluginsOn()).toEqual([]);
    expect(await accountingOn()).toBeNull();
    expect(await pluginOn("quickbooks")).toBe(false);
  });

  it("names QuickBooks on, by its key", async () => {
    await store(["quickbooks"]);
    expect(await pluginOn("quickbooks")).toBe(true);
    expect((await accountingOn())?.key).toBe("quickbooks");
    expect((await accountingOn())?.nouns?.books).toBe("QuickBooks");
  });

  it("passes over keys that aren't installed, a repeat, and a value that isn't a list", async () => {
    await store(["nothing-here", "quickbooks", "quickbooks"]);
    expect((await pluginsOn()).map((p) => p.key)).toEqual(["quickbooks"]);
    await store({ quickbooks: true });
    expect(await pluginsOn()).toEqual([]);
    await store([]);
    expect(await accountingOn()).toBeNull();
  });
});

describe("migration 0061", () => {
  const setup = (status: "open" | "finished") => db.insert(setting).values({ key: "setup.state", value: { status, step: "admin", adminEmail: null, finishedAt: null } })
    .onConflictDoUpdate({ target: setting.key, set: { value: { status, step: "admin", adminEmail: null, finishedAt: null } } });

  it("turns QuickBooks on where setup is finished: every club there is a QuickBooks club", async () => {
    await setup("finished");
    await db.execute(sql.raw(migration()));
    expect(await stored()).toEqual(["quickbooks"]);
    expect(await pluginOn("quickbooks")).toBe(true);
  });

  it("leaves a new installation, or one still in setup, with nothing on", async () => {
    await db.execute(sql.raw(migration()));
    expect(await stored()).toBeUndefined();
    await setup("open");
    await db.execute(sql.raw(migration()));
    expect(await stored()).toBeUndefined();
  });

  it("keeps a value already stored", async () => {
    await setup("finished");
    await store([]);
    await db.execute(sql.raw(migration()));
    expect(await stored()).toEqual([]);
  });
});

describe("finishing setup", () => {
  it("turns QuickBooks on, as setup has no step for the books yet, and says so in its audit row", async () => {
    const s = await seedStaff({ email: "a@club.org", admin: true });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    expect(await stored()).toEqual(["quickbooks"]);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "setup.finish"));
    expect(row!.after).toMatchObject({ pluginsOn: ["quickbooks"] });
  });

  it("keeps what is stored already", async () => {
    await store([]);
    const s = await seedStaff({ email: "a@club.org", admin: true });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    expect(await stored()).toEqual([]);
  });
});

describe("requirePluginPage()", () => {
  // Signed out in both: the staff guard, asked first, would send the visitor to sign in instead.
  it("answers not found while the plugin is off, before the staff guard is asked", async () => {
    await expect(guards.requirePluginPage("quickbooks", "Finance.Balance.Read")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(guards.requirePluginPage("not-installed")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("goes on to the staff guard while it is on: someone signed out is sent to sign in", async () => {
    await store(["quickbooks"]);
    await expect(guards.requirePluginPage("quickbooks", "Finance.Balance.Read")).rejects.toThrow(/NEXT_REDIRECT \/staff\/sign-in/);
  });
});
