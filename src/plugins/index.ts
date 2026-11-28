// The installed plugins, and which of them the club has on (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md,
// section 3, "How the core finds plugins"). Compiled in, one line each: nothing is loaded at run time. With ./types.ts,
// the only file under src/plugins/ the core may import (tests/unit/plugin-boundary.test.ts).
import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { PLUGINS_ON_KEY, type Plugin } from "./types";
import { quickbooks } from "./quickbooks/plugin";

/** Every plugin in this release, one line each. */
export const INSTALLED: readonly Plugin[] = [quickbooks];

export { PLUGINS_ON_KEY };

const stored = z.array(z.string().max(64)).max(32);

/**
 * The plugins that are on, as stored in `plugins.on`, in the list's order: keys of plugins not installed are passed
 * over, and of kind "accounting" only the first counts (one accounting system is on at a time). Nothing stored, or a
 * value that isn't a list, is none on: a new installation starts with none (section 6).
 */
export async function pluginsOn(tx?: Tx): Promise<Plugin[]> {
  const [row] = await (tx ?? db).select({ value: setting.value }).from(setting).where(eq(setting.key, PLUGINS_ON_KEY));
  const keys = stored.safeParse(row?.value);
  if (!keys.success) return [];
  const on: Plugin[] = [];
  for (const key of keys.data) {
    const p = INSTALLED.find((x) => x.key === key);
    if (!p || on.includes(p) || (p.kind === "accounting" && on.some((x) => x.kind === "accounting"))) continue;
    on.push(p);
  }
  return on;
}

/** Whether the installed plugin `key` is on. */
export async function pluginOn(key: string, tx?: Tx): Promise<boolean> {
  return (await pluginsOn(tx)).some((p) => p.key === key);
}

/** The accounting plugin that is on, or null when the club keeps no books in the portal. */
export async function accountingOn(tx?: Tx): Promise<Plugin | null> {
  return (await pluginsOn(tx)).find((p) => p.kind === "accounting") ?? null;
}

/** An installed plugin by its key, on or not (its words and actions read the same either way), or null. */
export const installedPlugin = (key: string): Plugin | null => INSTALLED.find((p) => p.key === key) ?? null;
