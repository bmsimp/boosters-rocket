import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { describeRequirement } from "@/lib/seasons/setup";
import { loadRequirementProgress, type ProgressRow } from "@/lib/seasons/staff-progress";
import { recordNameWords } from "@/lib/families/words";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { StateWords } from "@/app/components/state-words";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { familyProgressPage } from "@/app/staff/(app)/family-pages";
import { OneButton, TextAction } from "../../forms";
import { removeWaiverAction, setTicksAction, waiveAction } from "../../actions";

export const metadata = { title: "Requirement progress" };
export const dynamic = "force-dynamic";

/** How one family or student stands, in words: the state first, then when and by whom. Names and reasons are text only. */
function Standing({ row }: { row: ProgressRow }) {
  return (
    <>
      <StateWords state={row.state} words={row.words} />
      {row.metAt && <span className="when">Ticked <LocalTime iso={row.metAt} />{row.metBy ? ` by ${row.metBy}` : ""}</span>}
      {row.waivedAt && <span className="when">Waived <LocalTime iso={row.waivedAt} />{row.waivedBy ? ` by ${row.waivedBy}` : ""}: {row.waivedReason}</span>}
    </>
  );
}

export default async function RequirementProgressPage({ params, searchParams }: {
  params: Promise<{ requirementId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireStaffPage("Season.Progress.Read");
  const [{ requirementId }, sp] = await Promise.all([params, searchParams]);
  const progress = isUuid(requirementId) ? await loadRequirementProgress(requirementId, can(ctx.effective, "Finance.Balance.Read") ? "all" : "none") : null;
  if (!progress) notFound();
  const { requirement: r, step, season, rows, left, counts, ticked, rosterTag } = progress;
  const canChange = can(ctx.effective, "Season.Progress.ReadWrite");
  const typed = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const q = typed.toLowerCase();
  // A plain substring of the name or the family's name: nothing typed is a pattern.
  const shown = (rows ?? []).filter((row) => !q || row.name.toLowerCase().includes(q) || row.familyName.toLowerCase().includes(q));
  // "Everyone shown" is the list as it is filtered now; someone already as asked is left alone.
  const shownIds = shown.map((row) => String(row.id)), anyUnticked = shown.some((row) => !row.metAt), anyTicked = shown.some((row) => row.metAt);
  const noun = r.appliesTo === "family" ? "families" : "students";
  return (
    <main className="wrap single">
      <h1 className="page-title">{r.title}</h1>
      <p className="lede">In {step.name}, {season.name}. {describeRequirement(r)}{r.dueOn ? <> · Due <CalendarDate iso={r.dueOn} /></> : null}. <Link href={`/staff/seasons/progress?season=${season.id}`}>Back to {season.name}</Link>
        {can(ctx.effective, "Season.Steps.Read") && <> · <Link href={`/staff/seasons/${season.id}/requirements/${r.id}`}>Settings</Link></>}</p>

      {rows === null ? (
        <Notice tone="warning">The roster can&apos;t be shown right now, so nobody is listed. Check QuickBooks under Roster.</Notice>
      ) : (
        <section className="box" aria-labelledby="who-h"><h2 id="who-h">Who has done it</h2>
          <Notice tone={counts.asked > 0 && counts.todo === 0 ? "done" : "info"} live="none">{counts.asked === 0 ? `It is asked of no ${noun} on the roster right now.` : `${counts.done} of ${counts.asked} done${counts.waived ? `, ${counts.waived} waived` : ""}, ${counts.todo} still to do.`}</Notice>
          {counts.asked > 0 && (
            <form method="get" role="search" className="stack">
              <label className="field"><span>Find by name</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
              <button className="btn btn-line">Find</button>
            </form>
          )}
          {canChange && ticked && shown.length > 0 && (
            <div className="row-actions everyone-shown">
              {anyUnticked && <OneButton label={`Tick everyone shown (${shown.length})`} pendingLabel="Ticking…" act={setTicksAction.bind(null, r.id, rosterTag, shownIds, true)} />}
              {anyTicked && <OneButton label={`Untick everyone shown (${shown.length})`} pendingLabel="Unticking…" act={setTicksAction.bind(null, r.id, rosterTag, shownIds, false)} />}
            </div>
          )}
          {counts.asked > 0 && shown.length === 0 && <Notice tone="info">Nobody matches &quot;{typed}&quot;.</Notice>}
          {shown.length > 0 && <DataTable caption={typed ? `Matching "${typed}"` : `Every ${r.appliesTo === "family" ? "family" : "student"} it is asked of`} captionHidden
            className="progress-rows" rows={shown} rowKey={(row) => String(row.id)} columns={[
              { key: "name", header: r.appliesTo === "family" ? "Family" : "Student", rowHeader: true, cell: (row) => row.name },
              ...(r.appliesTo === "student" ? [{ key: "family", header: "Family", cell: (row: ProgressRow) => row.familyName }] : []),
              { key: "state", header: "Where it stands", cell: (row) => <Standing row={row} /> },
              // The family's QuickBooks id is the address; its name is only the link's words.
              { key: "page", header: "The family's page", cell: (row) => <Link href={familyProgressPage(row.familyId, season.id)}>Everything asked of {row.familyName}</Link> },
              ...(canChange ? [{ key: "do", header: "What you can do", quiet: true, cell: (row: ProgressRow) => (
                <div className="row-actions">
                  {ticked && (row.metAt
                    ? <OneButton label="Untick" pendingLabel="Unticking…" act={setTicksAction.bind(null, r.id, rosterTag, [String(row.id)], false)} />
                    : <OneButton label="Tick" pendingLabel="Ticking…" act={setTicksAction.bind(null, r.id, rosterTag, [String(row.id)], true)} />)}
                  {row.waivedAt
                    ? <OneButton label="Remove waiver" pendingLabel="Removing…" act={removeWaiverAction.bind(null, r.id, rosterTag, String(row.id))} />
                    : <details className="more"><summary>Waive for {row.name}</summary>
                        <TextAction field="Why? (kept in the audit log; the family doesn't see it)" label="Waive" pendingLabel="Waiving…" maxLength={500} multiline act={waiveAction.bind(null, r.id, rosterTag, String(row.id))} />
                      </details>}
                </div>) } satisfies Column<ProgressRow>] : []),
            ]} />}
        </section>
      )}

      {left.length > 0 && (
        <section className="box" aria-labelledby="left-h"><h2 id="left-h">No longer asked</h2>
          <p>Ticks and waivers recorded for someone who has left the roster, or whom the chosen list no longer names. They are kept, and families don&apos;t see them.</p>
          <DataTable caption="Ticks and waivers kept for someone no longer asked" captionHidden rows={left} rowKey={(row) => String(row.subjectId)} columns={[
            { key: "name", header: "Who", rowHeader: true, cell: (row) => recordNameWords(row.name, row.kind) },
            { key: "recorded", header: "Recorded", cell: (row) => (
              <>{row.metAt && <span className="t-line">Ticked <LocalTime iso={row.metAt} /></span>}
                {row.waivedAt && <span className="t-line">Waived <LocalTime iso={row.waivedAt} />: {row.waivedReason}</span>}</>) },
            ...(canChange ? [{ key: "do", header: "What you can do", quiet: true, cell: (row: (typeof left)[number]) => (
              <div className="row-actions">
                {row.metAt && <OneButton label="Untick" pendingLabel="Unticking…" act={setTicksAction.bind(null, r.id, rosterTag, [String(row.subjectId)], false)} />}
                {row.waivedAt && <OneButton label="Remove waiver" pendingLabel="Removing…" act={removeWaiverAction.bind(null, r.id, rosterTag, String(row.subjectId))} />}
              </div>) }] : []),
          ]} />
        </section>
      )}
    </main>
  );
}
