"use client";
import { useId, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { StatusDot } from "@/app/components/ui/status-dot";
import type { StatusTone } from "./statuses";

/** One rail entry, as the browser gets it: names, words and addresses only (every prop reaches the browser). */
export type RailEntry = { key: string; title: string; href: string; owns: string[]; keywords: string[]; status: { tone: StatusTone; words: string } };
export type RailGroup = { label: string; entries: RailEntry[] };
/** An integration a search can lead to, shown under Integrations when its name or a keyword matches. */
export type RailExtra = { key: string; title: string; href: string; keywords: string[] };

const ROOT = "/staff/settings";
const owned = (path: string, owns: string[]) => owns.some((o) => path === o || path.startsWith(`${o}/`));
const matches = (q: string, title: string, keywords: string[]) => [title, ...keywords].some((w) => w.toLowerCase().includes(q));

/**
 * The Settings rail: Find a setting, then each group's items with their one-line status, the current one marked. It is
 * navigation, never a guard (Overview at its top, for whoever may open it): the layout gives it only the items the person may open, and each page checks again. On a
 * phone it is drawn only at /staff/settings, as the first screen (each item opens as its own page, with a way back).
 *
 * Find a setting filters in the browser, with no request: an item's title and its fixed keywords, and the integrations
 * by theirs, shown under Integrations ("smtp" leads to Outgoing mail). Enter opens the first result; Escape clears.
 */
export function SettingsRail({ groups, extras, overview }: { groups: RailGroup[]; extras: RailExtra[]; overview: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const id = useId();
  const root = path === ROOT;
  const q = query.trim().toLowerCase();
  const current = groups.flatMap((g) => g.entries).find((e) => owned(path, e.owns))?.key ?? null;

  const shown = groups.map((g) => ({
    ...g,
    entries: q ? g.entries.filter((e) => matches(q, e.title, e.keywords)) : g.entries,
    found: q && g.entries.some((e) => e.key === "integrations") ? extras.filter((x) => matches(q, x.title, x.keywords)) : [],
  })).filter((g) => g.entries.length > 0 || g.found.length > 0);
  const first = shown[0] ? (shown[0].entries[0]?.href ?? shown[0].found[0]?.href) : undefined;

  const onKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Escape" && query) { ev.preventDefault(); setQuery(""); }
    if (ev.key === "Enter" && q && first) { ev.preventDefault(); setQuery(""); router.push(first); }
  };

  return (
    <nav className={root ? "settings-rail is-root list-pane" : "settings-rail list-pane"} aria-label="Settings">
      {root ? <h1 className="rail-title">Settings</h1> : <p className="rail-title">Settings</p>}
      <div className="rail-find" role="search">
        <label htmlFor={`${id}-find`} className="visually-hidden">Find a setting</label>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
        <input id={`${id}-find`} type="search" placeholder="Find a setting" autoComplete="off" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} aria-describedby={`${id}-found`} />
      </div>
      {/* The way back to the Overview, for whoever may open it: current only at /staff/settings itself. */}
      {overview && !q && <ul className="rail-top"><li><Link href={ROOT} aria-current={root ? "page" : undefined}><span className="rail-name">Overview</span></Link></li></ul>}
      <div id={`${id}-found`} className="rail-none" role="status">{q && shown.length === 0 ? "No setting matches" : ""}</div>
      {shown.map((g) => (
        <div key={g.label} className="rail-group">
          <p className="rail-label" id={`${id}-${g.label.replaceAll(" ", "-")}`}>{g.label}</p>
          <ul aria-labelledby={`${id}-${g.label.replaceAll(" ", "-")}`}>
            {g.entries.map((e) => (
              <li key={e.key}>
                <Link href={e.href} aria-current={e.key === current ? "page" : undefined} onClick={() => setQuery("")}>
                  <span className="rail-name">{e.title}</span>
                  <StatusDot tone={e.status.tone} words={e.status.words} className="rail-status" />
                </Link>
              </li>
            ))}
            {g.found.map((x) => (
              <li key={x.key} className="rail-sub">
                <Link href={x.href} onClick={() => setQuery("")}><span className="rail-name">{x.title}</span><span className="rail-in">in Integrations</span></Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
