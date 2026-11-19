import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { isUuid } from "@/lib/seasons/ids";
import { familyRecordAt } from "@/lib/families/address";
import { pairKey } from "@/lib/seasons/kinds";
import { linesLeft, type Line, type SubjectId } from "@/lib/seasons/progress";
import { defaultProgressSeasonId, loadFamilyProgress, type FamilyProgress } from "@/lib/seasons/staff-progress";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { StateWords } from "@/app/components/state-words";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";

export const metadata = { title: "Family progress" };
export const dynamic = "force-dynamic";

type Asked = Line & { subjectId: SubjectId };

/**
 * What one step asks of the family itself and of each student, as one table with a heading row for each of them:
 * each requirement with its state in words. The title leads to the requirement's own progress page, where it is ticked
 * off or waived. Names, titles and reasons are text only.
 */
function StepTable({ stepName, groups, waivers }: { stepName: string; groups: { key: string; who: string; lines: Asked[] }[]; waivers: FamilyProgress["waivers"] }) {
  const columns: Column<Asked>[] = [
    { key: "title", header: "Requirement", rowHeader: true, cell: (line) => <Link href={`/staff/seasons/progress/${line.requirementId}`}>{line.title}</Link> },
    { key: "required", header: "Required", cell: (line) => (line.required ? "Required" : "Optional") },
    { key: "state", header: "Where it stands", cell: (line) => {
      const waiver = waivers.get(pairKey(line.requirementId, line.subjectId));
      return (
        <>
          <StateWords state={line.state} words={line.words} />
          {waiver && <span className="t-line">Waived <LocalTime iso={waiver.at} />{waiver.by ? ` by ${waiver.by}` : ""}: {waiver.reason}</span>}
        </>
      );
    } },
    { key: "due", header: "Due", cell: (line) => (line.dueOn ? <CalendarDate iso={line.dueOn} /> : "No due date") },
  ];
  return (
    <DataTable caption={`What ${stepName} asks of the family and of each student`} captionHidden className="progress-rows" columns={columns}
      rowKey={(line) => `${String(line.subjectId)}|${line.requirementId}`}
      groups={groups.map((g) => ({ key: g.key, heading: g.who, rows: g.lines }))} />
  );
}

/** One family's standing through a season, in full. The season is the current one unless the address asks for another. */
export default async function FamilyProgressPage({ params, searchParams }: {
  params: Promise<{ familyId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireStaffPage("Season.Progress.Read");
  const [{ familyId }, sp] = await Promise.all([params, searchParams]);
  // Both come from the address, so both are checked before anything is looked up. The family is named by the app's own
  // id (stage 3 of the app-owned families spec): anything that isn't a family record's answers 404, before any other read.
  const asked = typeof sp.season === "string" ? sp.season : null;
  if (asked !== null && !isUuid(asked)) notFound();
  const record = await familyRecordAt(familyId);
  if (!record) notFound();
  const seasonId = asked ?? await defaultProgressSeasonId();
  const progress = seasonId ? await loadFamilyProgress(record, seasonId, can(ctx.effective, "Finance.Balance.Read") ? "all" : "none") : null;
  if (!progress) notFound();
  // A staff read of one family's data (spec §5): recorded before anything is shown, naming the app's own family.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "season.progress.family.read", permission: "Season.Progress.Read",
    targetType: "family", targetId: String(progress.family.id), ip: ctx.ip, after: { season: progress.season.name } });
  const { family, season, steps, currentIndex, waivers } = progress;
  return (
    <main className="wrap single season-page">
      <h1 className="page-title">{family.name}</h1>
      <p className="lede">Where this family stands in {season.name}{season.isCurrent ? ", the current season" : ", which parents don't see"}. Open a requirement to tick it off or waive it.{" "}
        <Link href={`/staff/seasons/progress?season=${season.id}`}>Back to {season.name}</Link></p>

      {steps.length === 0 && <Notice tone="info" live="none">This season has no steps yet.</Notice>}

      {steps.map((step, i) => {
        const students = step.students.filter((s) => s.lines.length > 0);
        const left = linesLeft(step.family) + step.students.reduce((sum, s) => sum + linesLeft(s.lines), 0);
        const groups = [
          ...(step.family.length > 0 ? [{ key: String(family.id), who: "The family", lines: step.family.map((l): Asked => ({ ...l, subjectId: family.id })) }] : []),
          ...students.map((s) => ({ key: String(s.id), who: s.name, lines: s.lines.map((l): Asked => ({ ...l, subjectId: s.id })) })),
        ];
        return (
          <section className="box" key={step.id} aria-labelledby={`step-${step.id}`}>
            <h2 id={`step-${step.id}`}>{i + 1}. {step.name}</h2>
            {i === currentIndex && <Notice tone="info" live="none">The step this family is on.</Notice>}
            {groups.length === 0 ? <Notice tone="info" live="none">Nothing is asked of this family in this step.</Notice> : (
              <>
                <StateWords state={left === 0 ? "done" : "todo"} words={left === 0 ? "Done" : `${left} ${left === 1 ? "thing" : "things"} left to do`} />
                <StepTable stepName={step.name} groups={groups} waivers={waivers} />
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
