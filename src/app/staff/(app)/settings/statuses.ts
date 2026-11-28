import { cache } from "react";
import { getClubSettings } from "@/lib/settings/club";
import { clubSaved } from "@/lib/setup/club-step";
import { listRoles, listStaff } from "@/lib/staff/roles";
import { readStoredSettings } from "@/lib/parents/settings";
import { providerSummaries, type ProviderSummary } from "@/lib/auth/providers";
import { mailAttention, mailSummary } from "@/lib/mail/settings";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { apiFailing, formsSummary } from "@/lib/forms/settings";
import { healthReport } from "@/lib/health/report";
import { messagesEmailAllowed } from "@/lib/settings/messages";
import { emailStandings } from "@/lib/mail/template-store";
import { newestAuditAt } from "@/lib/audit/query";
import { agentBeat, answering } from "@/lib/backups/status";
import { lastBackup } from "@/lib/health/backup";
import { BACKUP_OLD_MS } from "@/lib/health/report";
import { credentialStanding } from "../secret-expiry-rule";
import type { IntegrationKey, PageKey, SettingsItem } from "./sections";

/**
 * Each Settings item's one-line status (the rail's, the Overview's), and the Integrations page's rows, read from what
 * each page already reads. The words carry the state; the dot beside them only repeats it: `done` (green, working or
 * set), `due` (amber, needs attention), `neutral` (gray, off or not set up, which may be by choice). Nothing here is a
 * secret, a family's data or QuickBooks text, so a client component may be given it. Each read is cached for the one
 * request: the layout's rail and the page under it ask for the same.
 */
export type StatusTone = "done" | "due" | "neutral";
export type Status = { tone: StatusTone; words: string };

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 min ago", from a time on the server: the rail is drawn on each request. */
export function ago(at: Date, now = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${n(d, "day", "days")} ago`;
}

/** The six rows of the Integrations page, by the four systems they are for. */
export type IntegrationRowKey = "quickbooks" | "documenso" | "mail-graph" | "mail-smtp" | "staff-microsoft" | "staff-google";
export type IntegrationRow = {
  key: IntegrationRowKey; item: IntegrationKey; name: string; does: string; status: Status;
  /** A second label beside the name ("Sandbox"), or null. */
  badge: string | null;
  /** Where the row leads: its page, and for staff sign-in the provider's card on it. */
  href: string;
  /** For a credential with a date ("Certificate expires"), the date itself, which the page draws as a CalendarDate. */
  expires: { what: string; iso: string } | null;
};

/** The Health page's lines, read once a request: the rail counts them, and the Health and integration pages show them. */
export const healthLines = cache(() => healthReport());

const QB_DOES = "Reads families, students and invoices; sends the names and changes staff make on the roster.";

/**
 * QuickBooks' status takes in its Health line too (a change stuck on its way there, a check that failed), so the row,
 * the page's badge, the rail and the Overview never say "Connected" while the page itself says it needs attention.
 */
export const quickbooksRow = cache(async (): Promise<IntegrationRow> => {
  const [conn, problems, lines] = await Promise.all([connectionView(), quickbooksProblems(), healthLines()]);
  const health = lines.find((l) => l.key === "quickbooks");
  const status: Status = !conn.configured ? { tone: "neutral", words: "Not set up" }
    : !conn.connected ? { tone: "due", words: "Not connected" }
    : problems.length || health?.state === "attention" ? { tone: "due", words: "Needs attention" }
    : { tone: "done", words: "Connected" };
  return { key: "quickbooks", item: "quickbooks", name: "QuickBooks Online", does: QB_DOES, status, href: "/staff/settings/quickbooks", expires: null,
    badge: conn.configured && conn.environment === "sandbox" ? "Sandbox" : null };
});

export const documensoRow = cache(async (): Promise<IntegrationRow> => {
  const f = await formsSummary();
  const status: Status = f.origin === null ? { tone: "neutral", words: "Not set up" }
    : !f.tokenReadable ? { tone: "due", words: "Token can't be read" }
    : apiFailing(f.status) ? { tone: "due", words: "Last call failed" }
    : !f.status.lastApiOkAt ? { tone: "due", words: "Not checked yet" }
    : { tone: "done", words: "Connected" };
  return { key: "documenso", item: "forms", name: "Documenso", does: "Sends each form to sign and tells the portal when it is signed.", status,
    href: "/staff/settings/forms", badge: null, expires: null };
});

export const mailRows = cache(async (): Promise<IntegrationRow[]> => {
  const [m, attention] = await Promise.all([mailSummary(), mailAttention()]);
  const chosen = m.config?.method ?? null;
  const status = (method: "graph" | "smtp"): Status => chosen === null ? { tone: "neutral", words: "Not set up" }
    : chosen !== method ? { tone: "neutral", words: "Not in use" }
    : attention?.kind === "failing" ? { tone: "due", words: "Last email failed" }
    : attention?.kind === "not_tested" ? { tone: "due", words: "Not tested" }
    : { tone: "done", words: "Working" };
  const c = m.config;
  return [
    { key: "mail-graph", item: "mail", name: "Microsoft 365", status: status("graph"), href: "/staff/settings/mail", badge: null, expires: null,
      does: c?.method === "graph" ? `Sends as ${c.mailbox}.` : "Sends from a Microsoft 365 mailbox the club owns." },
    { key: "mail-smtp", item: "mail", name: "SMTP", status: status("smtp"), href: "/staff/settings/mail", badge: null, expires: null,
      does: c?.method === "smtp" ? `Sends through ${c.host}, from ${c.from}.` : "Sends through any mail server that takes a user name and password." },
  ];
});

/**
 * Staff sign-in's two rows. While neither provider works nobody can sign in as staff, so every row that isn't working
 * needs attention, "Not set up" included: one tone for that state wherever it is shown.
 */
export const signInRows = cache(async (): Promise<IntegrationRow[]> => {
  const saved = await providerSummaries();
  const now = new Date();
  const works = (s: ProviderSummary | undefined) => s !== undefined && ["working", "expiring"].includes(credentialStanding(s, now));
  const nobody = !saved.some((s) => works(s));
  const row = (key: "staff-microsoft" | "staff-google", s: ProviderSummary | undefined): IntegrationRow => {
    const cert = key === "staff-microsoft";
    const what = cert ? "Certificate" : "Secret";
    const standing = s ? credentialStanding(s, now) : null;
    const status: Status = !s ? { tone: nobody ? "due" : "neutral", words: "Not set up" }
      : standing === "unreadable" ? { tone: "due", words: "Can't be read" }
      : standing === "expired" ? { tone: "due", words: "Expired" }
      : standing === "expiring" ? { tone: "due", words: `${what} expires soon` }
      : { tone: "done", words: "Working" };
    return {
      key, item: "sign-in", name: cert ? "Microsoft" : "Google", status, badge: null, href: `/staff/settings/sign-in#${key}`,
      does: cert ? "Staff sign in with their Microsoft work or school account, by a certificate." : "Staff sign in with their Google account, by a client secret.",
      expires: s?.expiresAt && (standing === "expiring" || standing === "expired") ? { what: standing === "expired" ? `${what} expired` : `${what} expires`, iso: s.expiresAt.toISOString() } : null,
    };
  };
  return [row("staff-microsoft", saved.find((s) => s.key === "staff-microsoft")), row("staff-google", saved.find((s) => s.key === "staff-google"))];
});

/** The rows of the integrations a person may see, in the page's order. */
export async function integrationRows(items: readonly SettingsItem[]): Promise<IntegrationRow[]> {
  const keys = new Set(items.map((i) => i.key));
  const [qb, doc, mail, signin] = await Promise.all([
    keys.has("quickbooks") ? quickbooksRow() : null, keys.has("forms") ? documensoRow() : null,
    keys.has("mail") ? mailRows() : [], keys.has("sign-in") ? signInRows() : [],
  ]);
  return [...(qb ? [qb] : []), ...(doc ? [doc] : []), ...mail, ...signin];
}

/**
 * One status for each system (its rows taken together): a system needs attention when any row does; mail is "set up"
 * by its one method in use; staff sign-in is working when one provider works and none needs attention.
 */
export function systemStatus(rows: IntegrationRow[]): Status {
  if (rows[0]?.item === "sign-in" && !rows.some((r) => r.status.tone === "done")) return { tone: "due", words: "Nobody can sign in" };
  if (rows.some((r) => r.status.tone === "due")) return { tone: "due", words: "Needs attention" };
  if (rows.some((r) => r.status.tone === "done")) return { tone: "done", words: "Working" };
  return { tone: "neutral", words: "Not set up" };
}

/** The systems a person may see, each with its status, for the rail's Integrations line and the Overview. */
export async function systemStatuses(items: readonly SettingsItem[]): Promise<{ item: IntegrationKey; status: Status }[]> {
  const rows = await integrationRows(items);
  const items4 = [...new Set(rows.map((r) => r.item))];
  return items4.map((item) => ({ item, status: systemStatus(rows.filter((r) => r.item === item)) }));
}

const healthCount = cache(async () => (await healthLines()).filter((l) => l.state === "attention").length);

/** Each rail item's status. Only an item the person may see is asked for (the layout reads `railItems()`). */
export const RAIL_STATUS: Record<PageKey, (items: readonly SettingsItem[]) => Promise<Status>> = {
  async club() {
    const [club, saved] = await Promise.all([getClubSettings(), clubSaved()]);
    return !saved ? { tone: "due", words: "Not set yet" } : !club.storedColorValid ? { tone: "due", words: "Color not valid" } : { tone: "done", words: "Set" };
  },
  async messages() {
    return (await messagesEmailAllowed()) ? { tone: "done", words: "Emailing on" } : { tone: "neutral", words: "Emailing off" };
  },
  async emails() {
    const standings = Object.values(await emailStandings());
    const look = standings.filter((x) => x === "needs_look").length, changed = standings.filter((x) => x === "club").length;
    if (look) return { tone: "due", words: `${look} need${look === 1 ? "s" : ""} a look` };
    return changed ? { tone: "done", words: `${changed} changed` } : { tone: "neutral", words: "Default words" };
  },
  async staff() {
    const people = (await listStaff()).length;
    return { tone: people ? "done" : "neutral", words: n(people, "person", "people") };
  },
  async roles() {
    return { tone: "done", words: n((await listRoles()).length, "role", "roles") };
  },
  async parents() {
    const { settings, level } = await readStoredSettings();
    if (level === null) return { tone: "due", words: "Level unreadable" };
    if (!settings.signin) return { tone: "neutral", words: "Off" };
    return { tone: "done", words: level === "strict" ? "On, Strict" : "On, Standard" };
  },
  async integrations(items) {
    const systems = await systemStatuses(items);
    const due = systems.filter((s) => s.status.tone === "due").length, off = systems.filter((s) => s.status.tone === "neutral").length;
    if (due) return { tone: "due", words: `${due} need${due === 1 ? "s" : ""} attention` };
    if (off) return { tone: "neutral", words: `${off} not set up` };
    return { tone: "done", words: "All connected" };
  },
  async audit() {
    const at = await newestAuditAt();
    return { tone: "neutral", words: at ? `Last entry ${ago(at)}` : "Nothing yet" };
  },
  async health() {
    const attention = await healthCount();
    return attention ? { tone: "due", words: `${attention} need${attention === 1 ? "s" : ""} attention` } : { tone: "done", words: "All working" };
  },
  async backups() {
    const [beat, last] = await Promise.all([agentBeat(), lastBackup()]);
    if (!answering(beat)) return { tone: "due", words: "Not answering" };
    if (!last || Date.now() - Date.parse(last.at) > BACKUP_OLD_MS) return { tone: "due", words: "Needs attention" };
    return { tone: "done", words: "Backed up" };
  },
  async "design-system"() {
    return { tone: "neutral", words: "Samples only" };
  },
};
