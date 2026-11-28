import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import * as schema from "@/lib/db/schema";
import { ACTION_NAMES } from "@/lib/audit/actions";
import { ADMIN_ONLY, isPermission } from "@/lib/permissions/registry";
import { PERMISSION_AREAS, PERMISSION_WORDS } from "@/lib/permissions/words";
import { SETTINGS_ITEMS } from "@/app/staff/(app)/settings/sections";
import { INSTALLED } from "@/plugins";
import { ACCOUNTING_ABILITIES } from "@/plugins/types";

// Every installed plugin's manifest against what exists (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md,
// section 8): its permissions have words and an area, its actions have words, its pages and jobs exist, and every table
// has one owner, the core or exactly one plugin, with no core table pointing into a plugin's.

const ROOT = path.resolve(__dirname, "../..");

/** The core's tables: the portal with nothing added. A new table is added here or to one plugin's `tables`. */
const CORE_TABLES = [
  "setting", "auth_provider", "provider_certificate", "staff_user", "staff_auth_user", "staff_auth_session", "staff_auth_account", "staff_auth_verification", "role", "role_rule", "role_assignment", "audit_log", "job_run", "rate_limit_event",
  "parent", "family", "student", "guardian", "signin_code", "parent_signin_token", "parent_device", "parent_authenticator", "parent_backup_code", "parent_email_change",
  "parent_auth_user", "parent_auth_session", "parent_auth_account", "parent_auth_verification", "parent_auth_passkey",
  "season", "season_step", "requirement", "requirement_cover", "requirement_progress", "requirement_reminder",
  "volunteer_event", "volunteer_shift", "volunteer_shift_requirement", "volunteer_signup", "volunteer_credit", "volunteer_reminder",
  "signature_request", "signature_consent", "signed_form_evidence", "signed_form_file", "signed_form_copy", "form_reminder_claim", "form_reminder_round", "form_withdrawal",
  "message", "message_version", "message_file", "message_version_file", "message_read", "message_mail",
  "backup_request", "backup_file",
];

const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable));
const nameOf = (t: PgTable) => getTableConfig(t).name;

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...filesIn(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** The route folder under src/app for an address: "/staff/links" is src/app/staff/(app)/links, "/payments" src/app/(parent)/payments. */
function pageFile(p: string): string | null {
  const roots = p.startsWith("/staff/") ? ["src/app/staff/(app)", "src/app/staff"] : ["src/app/(parent)", "src/app"];
  const rest = p.startsWith("/staff/") ? p.slice("/staff".length) : p;
  for (const r of roots) { const f = `${r}${rest}/page.tsx`; if (existsSync(path.join(ROOT, f))) return f; }
  return null;
}

describe.each(INSTALLED.map((p) => [p.key, p] as const))("the %s plugin's manifest", (_key, plugin) => {
  it("has its permissions in the registry, each with words, Admin-only as the registry says, and an area where a role can be given it", () => {
    expect(plugin.permissions.length).toBeGreaterThan(0);
    for (const p of plugin.permissions) {
      expect(isPermission(p.name), p.name).toBe(true);
      expect(PERMISSION_WORDS[p.name], `${p.name} has no words`).toBeTruthy();
      // An Admin-only permission is on no role's checklist, so it has no area there.
      expect(PERMISSION_AREAS.some((a) => a.permissions.includes(p.name)), `${p.name}: an area`).toBe(!p.adminOnly);
      expect(ADMIN_ONLY.includes(p.name), `${p.name}: Admin-only`).toBe(p.adminOnly);
    }
  });

  it("gives every action it brings words, the words ACTION_NAMES shows", () => {
    expect(Object.keys(plugin.auditActions).length).toBeGreaterThan(0);
    for (const [action, words] of Object.entries(plugin.auditActions)) {
      expect(words, action).toBeTruthy();
      expect(ACTION_NAMES[action], action).toBe(words);
    }
  });

  it("names pages and route folders that exist, each with a permission of the registry or none", () => {
    for (const p of plugin.pages) {
      expect(pageFile(p.path), `${p.path} has no page.tsx`).not.toBeNull();
      if (p.permission !== null) expect(isPermission(p.permission), p.permission).toBe(true);
      const source = readFileSync(path.join(ROOT, pageFile(p.path)!), "utf8");
      // The page's guard checks the permission the manifest names (requirePluginPage() replaces it in slice P3).
      if (p.door === "staff") expect(source, p.path).toContain(p.permission === null ? "requireStaffPage()" : `"${p.permission}"`);
    }
  });

  it("names jobs the worker records runs under", () => {
    const sources = filesIn("src/lib").map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    for (const j of plugin.jobs) expect(sources, j.name).toContain(`"${j.name}"`);
  });

  it("is an item of Settings, a row of the Integrations page", () => {
    const item = SETTINGS_ITEMS.find((i) => i.key === plugin.settings);
    expect(item?.kind).toBe("integration");
  });

  it("declares nouns and known abilities when it keeps the books", () => {
    if (plugin.kind !== "accounting") return;
    expect(plugin.nouns?.books).toBeTruthy();
    for (const a of plugin.abilities ?? []) expect(ACCOUNTING_ABILITIES).toContain(a);
  });
});

describe("tables", () => {
  const all = tables.map(nameOf);

  it("each have one owner: the core, or exactly one plugin", () => {
    const owners = new Map<string, string[]>();
    for (const t of CORE_TABLES) owners.set(t, [...(owners.get(t) ?? []), "core"]);
    for (const p of INSTALLED) for (const t of p.tables) owners.set(t, [...(owners.get(t) ?? []), p.key]);
    const unowned = all.filter((t) => !owners.has(t));
    expect(unowned, "Add each table to CORE_TABLES here or to one plugin's `tables`").toEqual([]);
    const twice = [...owners].filter(([, o]) => o.length > 1).map(([t, o]) => `${t}: ${o.join(", ")}`);
    expect(twice).toEqual([]);
    const missing = [...owners.keys()].filter((t) => !all.includes(t));
    expect(missing, "These are named as owned but are no table of the schema").toEqual([]);
  });

  it("of the core never point into a plugin's (a plugin's may point at the core's)", () => {
    const plugins = new Set(INSTALLED.flatMap((p) => p.tables));
    const into = tables.filter((t) => CORE_TABLES.includes(nameOf(t))).flatMap((t) => getTableConfig(t).foreignKeys
      .map((fk) => nameOf(fk.reference().foreignTable)).filter((to) => plugins.has(to)).map((to) => `${nameOf(t)} -> ${to}`));
    expect(into).toEqual([]);
  });
});
