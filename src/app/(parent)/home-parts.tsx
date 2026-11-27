import type { MyStudent } from "@/lib/parents/my-family";
import type { MySeason } from "@/lib/seasons/my-season";
import type { Line } from "@/lib/seasons/progress";
import type { FamilyMoney } from "@/lib/money/family-money";
import type { MyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { dueState } from "@/lib/money/due";
import { STATE_WORDS } from "@/lib/forms/states";
import { firstName } from "@/lib/parents/first-name";
import { List, ListRow, ListSubRow } from "../components/ui/list";
import { SectionLabel } from "../components/ui/section-label";
import { LinkButton } from "../components/ui/button";
import { StateWords } from "../components/state-words";
import type { Tone } from "../components/ui/tone";
import { InvoiceRows, NotCurrentNote } from "./money-box";
import { RequirementDue, RequirementTitle, SeasonNotes, asksAnything, currentStep, doneCount, stepWords } from "./season-parts";

/**
 * Home's lists (docs/agents/ui.md: SectionLabel over a List of ListRow rows). Server components. Everything here comes
 * from what the page read for the session's family alone (loadFamilyMoney(ctx.familyId), loadMySeason(ctx),
 * loadMyFamily(ctx)); step names, titles and names are the club's or QuickBooks' text, written as text only.
 */

const isLate = (line: Line, today: string) => line.dueOn !== null && dueState(line.dueOn, today).tone === "late";

/** What is asked in the current step, each with whom it is asked of: the family's own first, then each listed student's. */
function askedNow(season: MySeason | null, students: MyStudent[] | null): { key: string; line: Line; who: string | null }[] {
  const step = currentStep(season);
  if (!step) return [];
  // Matched by the student's own record, never by name (two students may share one) nor by a QuickBooks id.
  const standing = new Map(step.students.map((s) => [String(s.id), s]));
  return [
    ...step.family.map((line) => ({ key: `f:${line.requirementId}`, line, who: null })),
    ...(students ?? []).flatMap((s) => (standing.get(String(s.id))?.lines ?? []).map((line) => ({ key: `${String(s.id)}:${line.requirementId}`, line, who: s.name }))),
  ];
}

/**
 * The way to a requirement still to do, where the parent can act on it: a form on the Forms page ("Sign" while it waits
 * for their signature), a volunteering one on Volunteer. A plain link: the Forms page makes a form's request when it is
 * opened, which must happen when a guardian asks for it and never ahead of time. Nothing for what staff record.
 */
function LineAction({ line, who }: { line: Line; who: string | null }) {
  const named = <span className="visually-hidden">: {line.title}{who ? `, ${who}` : ""}</span>;
  if (line.kind === "form" && line.words !== STATE_WORDS.notReady) {
    return <LinkButton plain size="sm" variant="tonal" href="/forms">{line.words === STATE_WORDS.notSigned ? "Sign" : "Open"}{named}</LinkButton>;
  }
  if (line.kind === "volunteer") return <LinkButton plain size="sm" variant="tonal" href="/volunteer">Open{named}</LinkButton>;
  return null;
}

/**
 * To do: one bordered list of what is left for the family, the open invoices first (each with its Pay), then each
 * requirement of the current step still to do for the family or a student (a payment one is its invoice, so it is left
 * to the invoice's row). The note for figures that are not current stands over it, where the paused Pays are.
 */
export function HomeToDo({ money, buyouts, season, students }: { money: FamilyMoney | null; buyouts?: MyBuyoutInvoices; season: MySeason | null; students: MyStudent[] | null }) {
  const f = money?.figures ?? null;
  const today = season?.today ?? money?.today ?? "";
  const left = askedNow(season, students).filter(({ line }) => line.state === "todo" && line.kind !== "payment");
  const empty = (!f || f.open.length === 0) && left.length === 0;
  return (
    <section className="home-todo" aria-labelledby="todo-h">
      <SectionLabel id="todo-h">To do</SectionLabel>
      {f && !f.current && <NotCurrentNote />}
      <List>
        {f && money && <InvoiceRows f={f} today={money.today} buyouts={buyouts} />}
        {left.map(({ key, line, who }) => (
          <ListRow key={key} status={{ tone: isLate(line, today) ? "late" : "due", words: line.words }} title={<RequirementTitle line={line} />}
            meta={[who && <span className="when">{firstName(who) ?? who}</span>, line.dueOn && <RequirementDue key="due" line={line} today={today} />]}
            action={<LineAction line={line} who={who} />} />
        ))}
        {empty && <ListRow status={{ tone: "done" }} title={f ? "Nothing to do right now" : "Nothing to sign or do right now"} />}
      </List>
    </section>
  );
}

/** A student's (or the family's own) row: where they stand in the step, the count, and each requirement indented under it. */
function StandingRow({ title, lines, stepName, today }: { title: string; lines: Line[]; stepName: string; today: string }) {
  const { state, words } = stepWords(lines, stepName);
  const tone: Tone = state === "done" ? "done" : lines.some((l) => l.state === "todo" && isLate(l, today)) ? "late" : "due";
  return (
    <ListRow status={{ tone, words }} title={title} amount={doneCount(lines) ?? undefined}
      sub={lines.length > 0 ? lines.map((line) => (
        <ListSubRow key={line.requirementId} title={<RequirementTitle line={line} />}
          meta={<><StateWords state={line.state} words={line.words} /><RequirementDue line={line} today={today} /></>} />
      )) : undefined} />
  );
}

/**
 * The family's students, each with where they stand in the current step and that step's requirements under them, then
 * what the step asks of the family itself. For a club that doesn't list students (`students` null), what the step asks
 * of the family alone, under the season's name, and nothing when it asks nothing and nothing is left behind.
 */
export function HomeStudents({ students, season }: { students: MyStudent[] | null; season: MySeason | null }) {
  const step = currentStep(season);
  const standing = new Map((step?.students ?? []).map((s) => [String(s.id), s]));
  const familyRow = step && step.family.length > 0 && <StandingRow title="Your family" lines={step.family} stepName={step.name} today={season!.today} />;
  if (students === null) {
    if (!season || (!familyRow && season.leftBefore === 0 && (step || !asksAnything(season)))) return null;
    return (
      <section className="home-students" aria-labelledby="step-h">
        <SectionLabel id="step-h">{season.name}</SectionLabel>
        {familyRow && <List>{familyRow}</List>}
        <SeasonNotes season={season} />
      </section>
    );
  }
  return (
    <section className="home-students" aria-labelledby="stu-h">
      <SectionLabel id="stu-h">Your students</SectionLabel>
      <List>
        {students.length > 0 ? students.map((s) => {
          const mine = step ? standing.get(String(s.id)) : undefined;
          return mine && step
            ? <StandingRow key={String(s.id)} title={s.name} lines={mine.lines} stepName={step.name} today={season!.today} />
            : <ListRow key={String(s.id)} title={s.name} />;
        }) : <ListRow title="The club has no active students listed for your family right now." />}
        {familyRow}
      </List>
      {season && <SeasonNotes season={season} />}
    </section>
  );
}
