import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadArchive } from "@/lib/signed-forms/evidence";
import { loadMatrix, parseMatrixFilter, type MatrixCell, type MatrixForm } from "@/lib/signed-forms/matrix";
import { CELL_WORDS, FILTER_STATES, cellTone } from "@/lib/signed-forms/rules";
import { CalendarDate } from "../../../components/calendar-date";
import { LocalTime } from "../../../components/local-time";
import { StateWords } from "../../../components/state-words";
import { remindFamilyAction, remindFormAction, saveScheduleAction } from "./actions";
import { RemindButton, ScheduleForm } from "./forms";

export const metadata = { title: "Signed forms" };
export const dynamic = "force-dynamic";

/** "12 of 40 signed, 2 waived", in words. */
const tally = (c: MatrixForm["counts"]) => (c.needed + c.waived === 0 ? "Asked of nobody on the roster" : `${c.signed} of ${c.needed} signed${c.waived ? `, ${c.waived} waived` : ""}`);

/** One cell: its state in words with an icon, and the way to the request or its evidence. Empty when the form doesn't cover them. */
function Cell({ cell, title, who }: { cell: MatrixCell; title: string; who: string }) {
  if (cell.state === "not_asked") return <td className="matrix-none"><span className="visually-hidden">Not asked</span></td>;
  const words = <StateWords state={cellTone(cell.state)} words={cell.words} />;
  const href = cell.evidenceId ? `/staff/forms/evidence/${cell.evidenceId}` : cell.requestId ? `/staff/forms/requests/${cell.requestId}` : null;
  return (
    <td>{href ? <Link href={href} className="matrix-link">{words}<span className="visually-hidden">: {title} for {who}</span></Link> : words}
      {cell.state === "signed" && !cell.evidenceId && <span className="when">Being filed</span>}</td>
  );
}

/**
 * Who has signed each form of the current season (v1 spec §9.3): students down the side, grouped by family, and the
 * season's forms across, a per-family form on the family's own row. It lists every family, so, like the roster list, it
 * is not audited; each request and each signed form's evidence is its own page, audited when it is opened. Filters
 * come from the address and are checked before use.
 */
export default async function SignedFormsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Forms.Signature.Read");
  const filter = parseMatrixFilter(await searchParams);
  const [matrix, archive] = await Promise.all([loadMatrix(filter), loadArchive()]);
  const writes = can(ctx.effective, "Forms.Signature.ReadWrite");
  const filtered = filter.formId !== null || filter.state !== null || filter.search !== "";
  return (
    <main className="wrap single">
      <h1 className="page-title">Signed forms</h1>
      <p className="lede">Who has signed each of this season&apos;s forms. Open a signed form to see its evidence and download it.</p>

      {!matrix && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No current season</h2><p>Once a season is the current one, its forms are listed here.</p></section>}

      {matrix && (
        <>
          <section className="box" aria-labelledby="forms-h">
            <h2 id="forms-h">{matrix.season.name}: the forms</h2>
            {matrix.allForms.length === 0 ? <p>This season asks for no forms.</p> : (
              <ul className="lines">{matrix.allForms.map((f) => (
                <li key={f.id}><div>
                  <span className="what">{f.title}</span>
                  <span className="when">{f.stepName} · {f.appliesTo === "family" ? "Each family" : "Each student"}{f.dueOn && <> · Due <CalendarDate iso={f.dueOn} /></>}{!f.setting && " · No template attached yet"}</span>
                  {writes && f.setting && (
                    <>
                      <RemindButton label="Remind now" run={remindFormAction.bind(null, f.id)} />
                      <details className="more"><summary>Reminder schedule{f.reminders ? "" : ": none"}</summary>
                        <ScheduleForm before={f.reminders?.before ?? []} weeklyAfter={f.reminders?.weeklyAfter ?? false} hasDueDate={f.dueOn !== null} save={saveScheduleAction.bind(null, f.id)} />
                      </details>
                    </>
                  )}
                </div><span className="amount num">{matrix.families ? tally(f.counts) : ""}</span></li>))}</ul>
            )}
          </section>

          {matrix.allForms.length > 0 && (
            <section className="box" aria-labelledby="who-h">
              <h2 id="who-h">Who has signed</h2>
              <form method="get" action="/staff/forms" className="matrix-filter">
                <label className="field"><span>Form</span>
                  <select name="form" defaultValue={filter.formId ?? ""}>
                    <option value="">Every form</option>
                    {matrix.allForms.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                  </select></label>
                <label className="field"><span>Where it stands</span>
                  <select name="state" defaultValue={filter.state ?? ""}>
                    <option value="">Any</option>
                    {FILTER_STATES.map((s) => <option key={s} value={s}>{CELL_WORDS[s]}</option>)}
                  </select></label>
                <label className="field"><span>Family or student name</span><input name="q" type="search" maxLength={100} defaultValue={filter.search} /></label>
                <div className="matrix-filter-go"><button type="submit" className="btn btn-line">Show</button>{filtered && <Link href="/staff/forms">Show everyone</Link>}</div>
              </form>

              {!matrix.families ? <p role="status">The roster can&apos;t be shown right now, so nobody is listed. Check QuickBooks under Roster.</p>
                : matrix.families.length === 0 ? <p role="status">{filtered ? "Nobody matches that." : "Nobody on the roster is asked for these forms."}</p> : (
                  <div className="matrix-wrap" role="region" aria-labelledby="who-h" tabIndex={0}>
                    <table className="matrix">
                      <thead><tr><th scope="col">Family and students</th>{matrix.forms.map((f) => <th scope="col" key={f.id}>{f.title}</th>)}</tr></thead>
                      {matrix.families.map((fam) => (
                        <tbody key={fam.qboId}>
                          <tr className="matrix-family"><th scope="rowgroup" colSpan={matrix.forms.length + 1}>
                            <span>{fam.name}</span>
                            {writes && <RemindButton label={`Remind ${fam.name}`} run={remindFamilyAction.bind(null, fam.qboId)} />}
                          </th></tr>
                          {fam.rows.map((row) => (
                            <tr key={`${row.kind}-${row.qboId}`}>
                              <th scope="row">{row.kind === "family" ? "The family" : row.name}</th>
                              {row.cells.map((cell, i) => <Cell key={matrix.forms[i]!.id} cell={cell} title={matrix.forms[i]!.title} who={row.name} />)}
                            </tr>
                          ))}
                        </tbody>
                      ))}
                    </table>
                  </div>
                )}
            </section>
          )}
        </>
      )}

      <section className="box" aria-labelledby="archive-h">
        <h2 id="archive-h">Earlier company</h2>
        <p>Signed forms kept from a QuickBooks company that is no longer connected. They are the club&apos;s record, so they are never deleted; families don&apos;t see them.</p>
        {archive.length === 0 ? <p>There are none.</p> : (
          <ul className="lines">{archive.map((a) => (
            <li key={a.id}><div>
              <Link className="what" href={`/staff/forms/evidence/${a.id}`}>{a.formTitle}</Link>
              <span className="when">{[a.subjectName, a.familyName, a.seasonName].filter(Boolean).join(" · ")}{a.completedAt && <> · Signed <LocalTime iso={a.completedAt.toISOString()} /></>}</span>
            </div></li>))}</ul>
        )}
      </section>
    </main>
  );
}
