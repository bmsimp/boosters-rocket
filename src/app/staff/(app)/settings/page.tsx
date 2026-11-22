import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { clubSaved } from "@/lib/setup/club-step";
import { providerSummaries } from "@/lib/auth/providers";
import { mailAttention, mailSummary } from "@/lib/mail/settings";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { getParentSettings } from "@/lib/parents/settings";
import { peopleWithAccess } from "@/lib/parents/switches";
import { apiFailing, formsSummary } from "@/lib/forms/settings";
import { StateWords } from "@/app/components/state-words";
import { LocalTime } from "@/app/components/local-time";
import { CalendarDate } from "@/app/components/calendar-date";
import { settingsItems, type SettingsItem } from "./sections";
import { credentialStanding } from "../secret-expiry-rule";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

type Section = Extract<SettingsItem, { key: BoxKey }>;
type BoxKey = "club" | "sign-in" | "mail" | "quickbooks" | "parents" | "forms";
type Summary = { state: "done" | "todo"; words: string; details: [string, ReactNode][]; open: string };
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Settings: one box for each part the person may see (sections.ts), saying in words what is set and whether it works,
 * and leading to that part's own page to set it up or change it. Nothing here is a form, and no secret is read.
 *
 * Every part but the Club is Admin only, and Settings.Club.Read comes with Settings.Club.ReadWrite, so the Club's
 * permission is the one every person with a section holds (tests/unit/settings-sections.test.ts). Anyone else is
 * refused: the guard, then the same refusal should a section list ever come up empty.
 */
export default async function SettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const sections = settingsItems(ctx.effective).filter((s): s is Section => s.key in LOADERS);
  if (sections.length === 0) redirect("/refused");
  const summaries = await Promise.all(sections.map((s) => LOADERS[s.key]()));
  return (
    <main className="wrap single settings-page">
      <h1 className="page-title">Settings</h1>
      <p className="lede">How the portal is set up. Each part says what is set and whether it works. Open a part to set it up or change it.</p>
      <div className="settings-grid">
        {sections.map((s, i) => <SectionBox key={s.key} section={s} summary={summaries[i]!} />)}
      </div>
    </main>
  );
}

function SectionBox({ section, summary }: { section: Section; summary: Summary }) {
  const id = `settings-${section.key}-h`;
  return (
    <section className="box" aria-labelledby={id} data-settings={section.key}>
      <h2 id={id}>{section.title}</h2>
      <StateWords state={summary.state} words={summary.words} />
      {summary.details.length > 0 && <dl className="details">{summary.details.map(([t, d]) => <Detail key={t} term={t} value={d} />)}</dl>}
      <p className="settings-open"><a className="btn btn-line" href={section.href}>{summary.open}</a></p>
    </section>
  );
}
const Detail = ({ term, value }: { term: string; value: ReactNode }) => <><dt>{term}</dt><dd>{value}</dd></>;

const LOADERS: Record<BoxKey, () => Promise<Summary>> = {
  async club() {
    const [club, saved] = await Promise.all([getClubSettings(), clubSaved()]);
    const state = saved && club.storedColorValid ? "done" : "todo";
    const words = !saved ? "Not set yet: the portal still shows the name Boosters Rocket" : club.storedColorValid ? "Set" : "The saved color isn't valid, so the default indigo is used";
    return { state, words, open: "Open club settings", details: [
      ["Name", club.name], ["Short name", club.shortName], ["Time zone", club.timeZone.replaceAll("_", " ")],
      ["Treasurer email", club.treasurerEmail ?? "None"],
    ] };
  },
  async "sign-in"() {
    const saved = await providerSummaries();
    const ms = saved.find((s) => s.key === "staff-microsoft"), google = saved.find((s) => s.key === "staff-google");
    const now = new Date();
    // A credential whose date has passed signs nobody in: it is not "working", whatever this server can read.
    const working = [ms && ["working", "expiring"].includes(credentialStanding(ms, now)) && "Microsoft",
      google && ["working", "expiring"].includes(credentialStanding(google, now)) && "Google"].filter(Boolean) as string[];
    const attention = [ms, google].some((s) => s && credentialStanding(s, now) !== "working");
    const line = (s: typeof ms, cert: boolean): ReactNode => {
      if (!s) return "Not set up";
      const what = cert ? "certificate" : "secret";
      const standing = credentialStanding(s, now);
      if (standing === "unreadable") return "Saved, but this server can't read it. Open the page to fix it.";
      if (!s.expiresAt) return "Working";
      const date = <CalendarDate iso={s.expiresAt.toISOString()} />;
      if (standing === "expired") return <>Its {what} expired on {date}: staff can&apos;t sign in with it. Open the page to replace it.</>;
      return <>{standing === "expiring" ? "Working, but its " : "Working. Its "}{what} expires {date}</>;
    };
    return {
      state: working.length && !attention ? "done" : "todo", words: working.length ? `Staff sign in with ${working.join(" and ")}` : "Nobody can sign in as staff yet",
      open: "Open sign-in settings", details: [["Microsoft", line(ms, true)], ["Google", line(google, false)]],
    };
  },
  async mail() {
    const [m, attention] = await Promise.all([mailSummary(), mailAttention()]);
    const c = m.config;
    const how = !c ? "Not set up" : c.method === "graph" ? `Microsoft 365, as ${c.mailbox}` : `SMTP through ${c.host}, from ${c.from}`;
    const words = !attention ? "Working" : attention.kind === "failing" ? "The last email failed" : attention.kind === "not_tested" ? "Saved, but not tested yet" : "Not set up yet";
    return {
      state: attention ? "todo" : "done", words, open: "Open mail settings",
      details: [["Sends with", how], ["Last tested", m.status.verifiedAt ? <LocalTime iso={m.status.verifiedAt} /> : "Not yet"]],
    };
  },
  async quickbooks() {
    const [conn, problems] = await Promise.all([connectionView(), quickbooksProblems()]);
    const words = !conn.configured ? "Not set up yet" : !conn.connected ? "Not connected" : problems.length ? "Connected, and something needs attention" : "Connected";
    // The company's name is QuickBooks text: a text child, never markup.
    return {
      state: conn.connected && problems.length === 0 ? "done" : "todo", words, open: "Open QuickBooks settings",
      details: conn.configured ? [
        ["Company", conn.connected ? (conn.companyName ?? "A QuickBooks company") : "None"],
        ["Which QuickBooks", conn.environment === "production" ? "Production (the club's real books)" : "Sandbox (an Intuit test company)"],
      ] : [],
    };
  },
  async parents() {
    const [s, people] = await Promise.all([getParentSettings(), peopleWithAccess()]);
    return {
      state: s.signin ? "done" : "todo", words: s.signin ? `On: ${n(people, "person", "people")} can sign in` : "Off: nobody can sign in",
      open: "Open parent sign-in settings", details: [["Welcome emails", s.welcome ? "On" : "Off"]],
    };
  },
  async forms() {
    const f = await formsSummary();
    const failing = apiFailing(f.status);
    const words = f.origin === null ? "Not set up yet" : !f.tokenReadable ? "Saved, but this server can't read the API token" : failing ? "The latest call to Documenso failed" : f.status.lastApiOkAt ? "Connected" : "Saved, but not checked yet";
    return {
      state: f.origin !== null && f.tokenReadable && !failing && f.status.lastApiOkAt ? "done" : "todo", words, open: "Open forms settings",
      details: f.origin === null ? [] : [["Documenso", <code key="o">{f.origin}</code>], ["Last answered", f.status.lastApiOkAt ? <LocalTime iso={f.status.lastApiOkAt} /> : "Not yet"]],
    };
  },
};
