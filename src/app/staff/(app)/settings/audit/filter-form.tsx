"use client";
import { useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

const noSubscribe = () => () => {};
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Midnight at the start of a day in the viewer's own time zone, plus whole days. */
function localMidnight(day: string, plusDays: number): Date | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type AuditFilterValues = { action: string; who: string; record: string; from: string | null; to: string | null };

/**
 * The audit log's filters. The address holds the two ends of the date range as instants; this form shows them as days
 * in the viewer's own time zone and turns the days chosen back into instants, so "15 November" means the viewer's
 * 15 November. Without JavaScript the form still submits: the days are then read as UTC days.
 */
export function AuditFilterForm({ values, actions }: { values: AuditFilterValues; actions: { code: string; name: string | null }[] }) {
  const router = useRouter();
  // The server and the hydrating render show UTC days (no hydration mismatch); the browser then switches to local days.
  const fromDay = useSyncExternalStore(noSubscribe, () => (values.from ? localDay(new Date(values.from)) : ""), () => (values.from ? values.from.slice(0, 10) : ""));
  const toDay = useSyncExternalStore(noSubscribe,
    () => (values.to ? localDay(new Date(Date.parse(values.to) - 1)) : ""),
    () => (values.to ? new Date(Date.parse(values.to) - 1).toISOString().slice(0, 10) : ""));

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const q = new URLSearchParams();
    for (const name of ["action", "who", "record"]) if (text(name)) q.set(name, text(name));
    const from = localMidnight(text("from"), 0), to = localMidnight(text("to"), 1);
    if (from) q.set("from", from.toISOString());
    if (to) q.set("to", to.toISOString());
    const s = q.toString();
    router.push(s ? `/staff/settings/audit?${s}` : "/staff/settings/audit");
  }

  return (
    <form method="get" action="/staff/settings/audit" role="search" className="stack" onSubmit={submit}>
      <label className="field"><span>What happened</span>
        <input name="action" list="audit-actions" defaultValue={values.action} autoComplete="off" placeholder="Anything" />
        <datalist id="audit-actions">{actions.map((a) => <option key={a.code} value={a.code}>{a.name ?? a.code}</option>)}</datalist>
      </label>
      <label className="field"><span>Who did it (part of a name or email)</span><input name="who" type="search" defaultValue={values.who} autoComplete="off" placeholder="Anyone" /></label>
      <label className="field"><span>The record it was done to (an id, or a kind like parent)</span><input name="record" type="search" defaultValue={values.record} autoComplete="off" placeholder="Any record" /></label>
      <label className="field"><span>From this day</span><input key={`from-${fromDay}`} name="from" type="date" defaultValue={fromDay} /></label>
      <label className="field"><span>To this day</span><input key={`to-${toDay}`} name="to" type="date" defaultValue={toDay} /></label>
      <div className="row-actions"><button className="btn btn-line">Show</button></div>
    </form>
  );
}
