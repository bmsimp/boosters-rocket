import { Fragment } from "react";
import { requireStaffPage } from "@/lib/guards";
import { healthReport, type HealthState } from "@/lib/health/report";
import { LocalTime } from "@/app/components/local-time";
import { PortalAddress } from "@/app/components/portal-address";
import { Notice } from "@/app/components/notice";

export const metadata = { title: "Health" };
export const dynamic = "force-dynamic";

/** The state as a word with a small picture beside it. The word carries the meaning; the color and the picture only repeat it. */
function StateWord({ state, word }: { state: HealthState; word: string }) {
  if (!word) return null;
  return (
    <span className={`state ${state === "ok" ? "done" : state === "attention" ? "todo" : ""}`.trim()}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === "ok" ? <path d="M3 8.5l3.2 3.2L13 5" /> : state === "attention" ? <path d="M8 2.5l6 10.5H2L8 2.5zM8 7v2.5M8 11.6v.1" /> : <path d="M4 8h8" />}
      </svg>
      {word}
    </span>
  );
}

/**
 * Whether each part of the portal is working, in plain words, with when it last worked (v1 spec §14). Admin only. It is
 * the page to open after an update or a restore. It shows no family's data, so opening it is not audited.
 */
export default async function HealthPage() {
  await requireStaffPage("Admin.Health.Read");
  const lines = await healthReport();
  const attention = lines.filter((l) => l.state === "attention").length;
  return (
    <main className="wrap single">
      <h1 className="page-title">Health</h1>
      <p className="lede">Whether each part of the portal is working, and when it last worked. Look here after an update or a restore. Only Admins see this page.</p>
      <Notice tone={attention === 0 ? "done" : "warning"}>{attention === 0 ? "Everything that is set up is working." : attention === 1 ? "1 thing needs attention." : `${attention} things need attention.`}</Notice>

      <section className="box" aria-labelledby="health-h"><h2 id="health-h">The portal</h2>
        <ul className="lines">{lines.map((l) => (
          <li key={l.key} data-health={l.key} data-state={l.state}><div>
            <span className="what"><b>{l.title}</b></span>
            <span className="when">{l.says}</span>
            {l.times.length > 0 && <span className="when">{l.times.map((t, i) => (
              <Fragment key={t.label}>{i > 0 ? " · " : ""}{t.label}: {t.at ? <LocalTime iso={t.at} /> : "never"}</Fragment>))}</span>}
            {l.notes.map((n) => <span className="when" key={n}>{n}</span>)}
            {l.fix && <span className="when"><a className="link-line" href={l.fix.href}>{l.fix.label}</a></span>}
          </div>
          <StateWord state={l.state} word={l.word} /></li>))}
        </ul>
      </section>

      <section className="box" aria-labelledby="health-address-h"><h2 id="health-address-h">The portal&apos;s address</h2>
        <PortalAddress />
      </section>
    </main>
  );
}
