// What a plugin declares (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 3). Plain data, and
// the core may import it: this file and ./index.ts are the only ones under src/plugins/ the core reads
// (tests/unit/plugin-boundary.test.ts). It imports nothing from a plugin.
import type { Permission } from "@/lib/permissions/registry";

/** The setting that says which installed plugins are on: a list of their keys (read through ./index.ts). */
export const PLUGINS_ON_KEY = "plugins.on";

/** A plugin's kind. One plugin of kind "accounting" is on at a time; "integration" makes room for later ones. */
export type PluginKind = "accounting" | "integration";

/**
 * The optional abilities of an accounting system (section 7 of the app-owned families spec). Every accounting plugin
 * must connect, disconnect, list customers, read a customer's invoices, balance and Pay links, and list products; these
 * it declares when it can. A button that needs one is drawn only while the plugin that is on declares it.
 */
export const ACCOUNTING_ABILITIES = [
  "customer.create", "customer.rename", "customer.move", "customer.makeInactive",
  "contact.update", "email.update", "invoice.create", "invoice.void",
] as const;
export type AccountingAbility = (typeof ACCOUNTING_ABILITIES)[number];

/** How the screens name the books of the plugin that is on: "QuickBooks", "customer", "customers". */
export type BooksNouns = { books: string; customer: string; customers: string };

/**
 * A permission the plugin brings. Its words and area are in src/lib/permissions/words.ts and its name in the registry
 * (src/lib/permissions/registry.ts) until the plugin's code moves behind the boundary (slice P7): then they join the
 * registry from here at build.
 */
export type PluginPermission = { name: Permission; adminOnly: boolean };

/** A page the plugin brings: a staff menu entry, a parent tab, a Settings page or a page of its own, by address. */
export type PluginPage = { path: string; door: "staff" | "parent"; permission: Permission | null };

/** A job the worker runs for the plugin, by the name its runs are recorded under (`job_run.job`). */
export type PluginJob = { name: string; due: string };

/**
 * The places on core screens a plugin fills (section 3, "Slots"). Each takes only what the core gives it, and a slot
 * no plugin fills draws nothing. They join here in the slices that make them (P2 to P6).
 */
export type Slots = Record<never, never>;

/**
 * One manifest per plugin, in src/plugins/<key>/plugin.ts. Slice P1 declares what exists today; the slots, jobs' runs,
 * Health lines and turning off join it in the slices that move them (P3 to P9).
 */
export type Plugin = {
  key: string;
  kind: PluginKind;
  /** The name a person reads: "QuickBooks Online". */
  name: string;
  /** Accounting only. */
  nouns?: BooksNouns;
  /** Accounting only. */
  abilities?: readonly AccountingAbility[];
  permissions: readonly PluginPermission[];
  /** Action -> words, as ACTION_NAMES (src/lib/audit/actions.ts) holds them. */
  auditActions: Readonly<Record<string, string>>;
  /** The tables it owns. A core table never has a foreign key into one of them. */
  tables: readonly string[];
  /** Its item in SETTINGS_ITEMS (src/app/staff/(app)/settings/sections.ts), by key: a row of the Integrations page. */
  settings: string;
  pages: readonly PluginPage[];
  jobs: readonly PluginJob[];
  slots: Partial<Slots>;
};
