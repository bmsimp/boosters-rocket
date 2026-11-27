import { getClubSettings } from "@/lib/settings/club";
import { listRoles, listStaff } from "@/lib/staff/roles";
import { getParentSettings } from "@/lib/parents/settings";
import { signinCounts } from "@/lib/parents/switches";
import { messageCounts } from "@/lib/messages/staff";
import { auditCountSince, newestAuditAt } from "@/lib/audit/query";
import { messagesEmailAllowed } from "@/lib/settings/messages";
import { backupRows } from "@/lib/backups/status";
import { readOffsite } from "@/lib/backups/offsite";
import { lastBackup } from "@/lib/health/backup";
import { SETTINGS_ITEMS, type PageKey, type SettingsItem } from "./sections";
import { healthLines, RAIL_STATUS, systemStatuses, type Status } from "./statuses";

/**
 * The Settings Overview's status cards (the owner's approval of 2026-11-27): one card for each area of the rail the
 * person may open but the design system (samples only), each with its status (the rail's own, RAIL_STATUS), two or
 * three facts and the one button that opens it. Every fact is a count, a setting's value or a time: nothing about a
 * family or a person, no secret, and no QuickBooks text. Each area's facts are read only for someone who sees its card.
 */
export type Fact = { key: string; label: string; text?: string; at?: string; swatch?: boolean };
export type OverviewCard = {
  key: PageKey; title: string; href: string; status: Status; button: string; facts: Fact[];
  /** Integrations only: each system the person may see, with its status. */
  systems?: { key: string; name: string; status: Status }[];
};

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const WEEK_MS = 7 * 86_400_000;
const BUTTONS: Partial<Record<PageKey, string>> = { audit: "Open the audit log" };

const FACTS: Partial<Record<PageKey, (items: readonly SettingsItem[]) => Promise<Fact[]>>> = {
  async club() {
    const club = await getClubSettings();
    return [
      { key: "name", label: "Name", text: club.name },
      { key: "color", label: "Color", text: club.color.toUpperCase(), swatch: true },
      { key: "zone", label: "Time zone", text: club.timeZone },
    ];
  },
  async messages() {
    const [counts, email] = await Promise.all([messageCounts(), messagesEmailAllowed()]);
    return [
      { key: "posted", label: "Posted", text: n(counts.posted, "message", "messages") },
      counts.latestAt ? { key: "latest", label: "Newest", at: counts.latestAt.toISOString() } : { key: "latest", label: "Newest", text: "None yet" },
      { key: "email", label: "Email to families", text: email ? "On" : "Off" },
    ];
  },
  async staff() {
    const [people, roles] = await Promise.all([listStaff(), listRoles()]);
    const admin = roles.find((r) => r.key === "admin")?.id;
    const active = people.filter((p) => p.status === "active");
    return [
      { key: "active", label: "Can sign in", text: n(active.length, "person", "people") },
      { key: "admins", label: "Admins", text: String(active.filter((p) => p.roles.some((r) => r.id === admin)).length) },
      { key: "blocked", label: "Blocked", text: String(people.length - active.length) },
    ];
  },
  async roles() {
    const roles = await listRoles();
    return [
      { key: "builtin", label: "Built in", text: String(roles.filter((r) => r.builtin).length) },
      { key: "custom", label: "Made by the club", text: String(roles.filter((r) => !r.builtin).length) },
    ];
  },
  async parents() {
    const [settings, counts] = await Promise.all([getParentSettings(), signinCounts()]);
    return [
      { key: "people", label: "Can sign in", text: `${n(counts.people, "person", "people")}, ${n(counts.families, "family", "families")}` },
      { key: "welcome", label: "Welcome emails", text: settings.welcome ? "On" : "Off" },
    ];
  },
  async audit() {
    const [at, week] = await Promise.all([newestAuditAt(), auditCountSince(new Date(Date.now() - WEEK_MS))]);
    return [
      at ? { key: "latest", label: "Newest entry", at: at.toISOString() } : { key: "latest", label: "Newest entry", text: "None yet" },
      { key: "week", label: "In the last 7 days", text: n(week, "entry", "entries") },
    ];
  },
  async health() {
    const lines = await healthLines();
    const backup = lines.find((l) => l.key === "backup");
    const backedUp = backup?.times.find((t) => t.at)?.at ?? null;
    return [
      { key: "checks", label: "Checks working", text: `${lines.filter((l) => l.state === "ok").length} of ${lines.length}` },
      ...lines.filter((l) => l.state === "attention").slice(0, 2).map((l): Fact => ({ key: `line-${l.key}`, label: l.title, text: l.word })),
      backedUp ? { key: "backup", label: "Last backup", at: backedUp } : { key: "backup", label: "Last backup", text: "None recorded" },
    ];
  },
  async backups() {
    const [last, rows, offsite] = await Promise.all([lastBackup(), backupRows(), readOffsite()]);
    return [
      last ? { key: "last", label: "Last backup", at: last.at } : { key: "last", label: "Last backup", text: "None yet" },
      { key: "kept", label: "On the server", text: n(rows.length, "backup", "backups") },
      { key: "offsite", label: "Off-site copies", text: offsite ? "On" : "Off" },
    ];
  },
};

/** The cards for the rail items a person may open (`rail`), in the rail's order; `visible` is everything they may see. */
export async function overviewCards(rail: readonly SettingsItem[], visible: readonly SettingsItem[]): Promise<OverviewCard[]> {
  const pages = rail.filter((i): i is Extract<SettingsItem, { kind: "page" }> => i.kind === "page" && i.key !== "design-system");
  return Promise.all(pages.map(async (i): Promise<OverviewCard> => {
    const [status, facts, systems] = await Promise.all([
      RAIL_STATUS[i.key](visible),
      FACTS[i.key]?.(visible) ?? [],
      i.key === "integrations" ? systemStatuses(visible) : null,
    ]);
    return {
      key: i.key, title: i.title, href: i.href, status, facts, button: BUTTONS[i.key] ?? `Open ${i.title}`,
      ...(systems ? { systems: systems.map((s) => ({ key: s.item, name: SETTINGS_ITEMS.find((x) => x.key === s.item)!.title, status: s.status })) } : {}),
    };
  }));
}
