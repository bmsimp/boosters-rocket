import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadArchive, loadOtherKept, type ArchiveEntry } from "@/lib/signed-forms/evidence";
import { loadMatrix, parseMatrixFilter, type MatrixCell, type MatrixForm, type MatrixRow } from "@/lib/signed-forms/matrix";
import { CELL_WORDS, FILTER_STATES, cellTone } from "@/lib/signed-forms/rules";
import { CalendarDate } from "../../../components/calendar-date";
import { LocalTime } from "../../../components/local-time";
import { StateWords } from "../../../components/state-words";
import { DataTable } from "../../../components/data-table";
import { Notice } from "../../../components/notice";
import { Drawer } from "../../../components/ui";
import { remindFamilyAction, remindFormAction, saveScheduleAction } from "./actions";
import { RemindButton, ScheduleForm } from "./forms";

export const metadata = { title: "Signed forms" };
export const dynamic = "force-dynamic";

/** A form's reminder schedule in words: "Reminders: 7 and 1 days before, then weekly", or "Reminders: none". */
function scheduleWords(r: MatrixForm["reminders"]): string {
  const days = [...(r?.before ?? [])].sort((a, b) => b - a);
  const parts = [days.length ? `${days.join(", ").replace(/, (\d+)$/, " and $1")} ${days.length === 1 && days[0] === 1 ? "day" : "days"} before` : "", r?.weeklyAfter ? "weekly after" : ""].filter(Boolean);
  return `Reminders: ${parts.length ? parts.join(", then ") : "none"}`;
}

/** "12 of 40 signed, 2 waived", in words. */
const tally = (c: MatrixForm["counts"]) => (c.needed + c.waived === 0 ? "Asked of nobody on the roster" : `${c.signed} of ${c.needed} signed${c.waived ? `, ${c.waived} waived` : ""}`);

/** One cell: its state in words with an icon, and the way to the request or its evidence. "Not asked" when the form doesn't cover them. */
function Cell({ cell, title, who }: { cell: MatrixCell; title: string; who: string }) {
  if (cell.state === "not_asked") return <span className="matrix-none">Not asked</span>;
  const words = <StateWords state={cellTone(cell.state)} words={cell.words} />;
  const href = cell.evidenceId ? `/staff/forms/evidence/${cell.evidenceId}` : cell.requestId ? `/staff/forms/requests/${cell.requestId}` : null;
  return (
    <>{href ? <Link href={href} className="matrix-link">{words}<span className="visually-hidden">: {title} for {who}</span></Link> : words}
      {cell.state === "signed" && !cell.evidenceId && <span className="when">Being filed</span>}</>
  );
}

/** Kept signed forms the matrix doesn't lead to, a row each: the form, who it was for, the season, when it was signed. */
function KeptTable({ entries, caption }: { entries: ArchiveEntry[]; caption: string }) {
  return (
    <DataTable caption={caption} captionHidden rows={entries} rowKey={(a) => a.id} columns={[
      { key: "form", header: "Form", rowHeader: true, cell: (a) => <Link href={`/staff/forms/evidence/${a.id}`}>{a.formTitle}</Link> },
      { key: "who", header: "For", cell: (a) => [a.subjectName, a.familyName].filter(Boolean).join(", ") || "Not recorded" },
      { key: "season", header: "Season", cell: (a) => a.seasonName ?? "Not recorded" },
      { key: "signed", header: "Signed", cell: (a) => (a.completedAt ? <LocalTime iso={a.completedAt.toISOString()} /> : "Not recorded") },
    ]} />
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
  const others = await loadOtherKept(matrix?.shownEvidenceIds ?? [], filter.search);
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
              <DataTable caption="Each form this season asks for, and how many have signed it" captionHidden rows={matrix.allForms} rowKey={(f) => f.id} columns={[
                { key: "form", header: "Form", rowHeader: true, cell: (f) => <>{f.title}{!f.setting && <span className="when">No template attached yet</span>}</> },
                { key: "step", header: "Step", cell: (f) => f.stepName },
                { key: "asked", header: "Asked of", cell: (f) => (f.appliesTo === "family" ? "Each family" : "Each student") },
                { key: "due", header: "Due", cell: (f) => (f.dueOn ? <CalendarDate iso={f.dueOn} /> : "No due date") },
                { key: "signed", header: "Signed", numeric: true, cell: (f) => tally(f.counts) },
                ...(writes ? [{ key: "remind", header: "Reminders", quiet: true, cell: (f: MatrixForm) => (f.setting ? (
                  <>
                    <RemindButton label="Remind now" run={remindFormAction.bind(null, f.id)} />
                    <span className="when">{scheduleWords(f.reminders)}</span>
                    <Drawer param="reminders" value={f.id} label="Change the reminder schedule" size="sm" title={`Reminder schedule for ${f.title}`}>
                      <ScheduleForm before={f.reminders?.before ?? []} weeklyAfter={f.reminders?.weeklyAfter ?? false} hasDueDate={f.dueOn !== null} save={saveScheduleAction.bind(null, f.id)} />
                    </Drawer>
                  </>) : null) }] : []),
              ]} />
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

              {matrix.families.length === 0 ? <Notice tone="info">{filtered ? "Nobody matches that." : "Nobody on the roster is asked for these forms."}</Notice> : (
                  <div className="matrix-wrap" role="region" aria-labelledby="who-h" tabIndex={0}>
                    <DataTable caption="Students down the side, by family, and the season's forms across" captionHidden className="matrix"
                      rowKey={(row: MatrixRow) => `${row.kind}-${row.id}`}
                      columns={[
                        { key: "who", header: "Family and students", rowHeader: true, cell: (row: MatrixRow) => (row.kind === "family" ? "The family" : row.name) },
                        ...matrix.forms.map((f, i) => ({ key: f.id, header: f.title, cell: (row: MatrixRow) => <Cell cell={row.cells[i]!} title={f.title} who={row.name} /> })),
                      ]}
                      groups={matrix.families.map((fam) => ({ key: fam.id, rows: fam.rows, heading: (
                        <><span>{fam.name}</span>{writes && fam.remindable && <RemindButton label={`Remind ${fam.name}`} run={remindFamilyAction.bind(null, fam.id)} />}</>) }))} />
                  </div>
                )}
            </section>
          )}
        </>
      )}

      <section className="box" aria-labelledby="others-h">
        <h2 id="others-h">Other kept signed forms</h2>
        <p>Signed forms not in the table above: earlier seasons&apos;, or for someone no longer on the roster. Each is kept as signed.</p>
        {others.entries.length === 0 ? <p>There are none{filter.search ? " matching the search" : ""}.</p> : <KeptTable entries={others.entries} caption="Each kept form, who it was for, and when it was signed" />}
        {others.more && <p className="help">Showing the newest {others.entries.length}. Search by a name above to find an older one.</p>}
      </section>

      <section className="box" aria-labelledby="archive-h">
        <h2 id="archive-h">Earlier company</h2>
        <p>Forms set aside by a change of QuickBooks company, from before the portal kept families across one. They&apos;re the club&apos;s record, so they&apos;re never deleted, and families don&apos;t see them.</p>
        {archive.length === 0 ? <p>There are none.</p> : <KeptTable entries={archive} caption="Each form kept from a company no longer connected" />}
      </section>
    </main>
  );
}
