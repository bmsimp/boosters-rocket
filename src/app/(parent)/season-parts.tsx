import type { MySeason } from "@/lib/seasons/my-season";
import { linesLeft, type Line, type StepStanding } from "@/lib/seasons/progress";
import { dueState } from "@/lib/money/due";
import { CalendarDate } from "../components/calendar-date";
import { StateWords } from "../components/state-words";
import { StepIndicator } from "../components/ui/step-indicator";

/**
 * The season as a parent sees it: the ruler on Home, and each requirement's progress in words. Server components.
 * Everything here comes from loadMySeason(ctx, ...), which reads the session's family alone. Step names, requirement
 * titles and student names are the club's or QuickBooks' text, written as text only.
 */

const TONE = { later: "when", soon: "when soon", late: "when late" } as const;
const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;
/** The letter on a student's dot: the first of their name. */
const initial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * The season ruler (StepIndicator, docs/agents/ui.md): the steps in order on a thin track, the finished ones behind the
 * current one ticked, the current one in the club's color, and a dot for each student on it. Not a control. The dots are decoration: the same
 * facts are in words in the students box. Nothing is drawn for a season with no steps. To a parent a step is a "set",
 * the word the ruler's design uses; staff, who build the season, call it a step.
 *
 * A season that asks nothing of this family, in any set, is not called done. With no dates every set of it counts as
 * finished, and the ruler would tick them all and say so, until the day staff add the first requirement. Its sets are
 * drawn with no ticks, and the heading says there is nothing to do yet.
 */
export function SeasonRuler({ season }: { season: MySeason }) {
  const { steps, currentIndex } = season;
  if (steps.length === 0) return null;
  const current = currentIndex === null ? null : steps[currentIndex]!;
  const nothingAsked = currentIndex === null && !asksAnything(season);
  return (
    <section className="season" aria-labelledby="season-h">
      <div className="wrap">
        <div className="season-head">
          <p id="season-h" className="season-title">{season.name} · <b>{current
            ? <>Set {currentIndex! + 1} of {steps.length}<span className="current-name">: {current.name}</span></>
            : nothingAsked ? <>Nothing to do yet</>
            : steps.length === 1 ? <>The one set is done</> : <>All {steps.length} sets done</>}</b></p>
          <a href="/season">See the whole season</a>
        </div>
        <StepIndicator steps={steps.map((step, i) => {
          const isCurrent = i === currentIndex;
          // The ruler reads from left to right: only a set behind the current one is ticked. One still ahead is
          // drawn as still to come, even when it asks nothing of this family and so is done already.
          const behind = currentIndex === null || i < currentIndex;
          const ticked = behind && step.done && !nothingAsked;
          return {
            key: step.id, label: step.name, done: ticked, current: isCurrent,
            words: isCurrent ? ", current set" : ticked ? ", done" : behind && !nothingAsked ? ", not finished" : "",
            marker: isCurrent && step.students.length > 0 && (
              <span className="on-set" aria-hidden="true">
                {step.students.map((s) => <i key={String(s.id)} className={s.done ? "done" : undefined} title={s.done ? `${first(s.name)} is done` : `${first(s.name)} has more to do`}>{initial(s.name)}</i>)}
              </span>
            ),
          };
        })} />
      </div>
    </section>
  );
}

/** A requirement's due date in words while something is left ("Due Nov 22", "Was due Oct 30"); nothing otherwise. */
export function RequirementDue({ line, today }: { line: Line; today: string }) {
  const due = line.dueOn ? dueState(line.dueOn, today) : null;
  return due ? <span className={TONE[due.tone]}>{due.lead} <CalendarDate iso={line.dueOn!} />{due.tail}</span> : null;
}

/** A requirement's title, and "(optional)" when it is not required. */
export function RequirementTitle({ line }: { line: Line }) {
  return <>{line.title}{!line.required && <span className="optional"> (optional)</span>}</>;
}

/** One requirement as it stands: its title, the state in words with its icon, and the due date while something is left. */
function RequirementLine({ line, today }: { line: Line; today: string }) {
  return (
    <li>
      <span className="what"><RequirementTitle line={line} /></span>
      <StateWords state={line.state} words={line.words} />
      <RequirementDue line={line} today={today} />
    </li>
  );
}

export function RequirementLines({ lines, today }: { lines: Line[]; today: string }) {
  return <ul className="reqs">{lines.map((line) => <RequirementLine key={line.requirementId} line={line} today={today} />)}</ul>;
}

/** Where one student, or the family, stands in a step, in words: done, or how much is left. */
export function stepWords(lines: Line[], stepName: string): { state: "done" | "todo"; words: string } {
  const left = linesLeft(lines);
  if (lines.length === 0) return { state: "done", words: `Nothing to do in ${stepName}` };
  return left === 0 ? { state: "done", words: `Done with ${stepName}` } : { state: "todo", words: `${things(left)} left to do in ${stepName}` };
}

/** Where one student, or the family, stands in a step: done, or how much is left. */
export function StepState({ lines, stepName }: { lines: Line[]; stepName: string }) {
  const { state, words } = stepWords(lines, stepName);
  return <StateWords state={state} words={words} />;
}

/** "2 of 3 done", counting the required items; null when none is required. */
export function doneCount(lines: Line[]): string | null {
  const required = lines.filter((l) => l.required);
  if (required.length === 0) return null;
  return `${required.length - linesLeft(lines)} of ${required.length} done`;
}

/** The step Home shows: the current one, or null when the season has none to show. */
export const currentStep = (season: MySeason | null): StepStanding | null =>
  season && season.currentIndex !== null ? season.steps[season.currentIndex] ?? null : null;

/** True when the season asks anything at all of this family, in any step. */
export const asksAnything = (season: MySeason) => season.steps.some((s) => s.family.length > 0 || s.students.some((x) => x.lines.length > 0));

/** Under Home's students: what is left from earlier steps, or thanks when every set is done. */
export function SeasonNotes({ season }: { season: MySeason }) {
  const step = currentStep(season);
  return (
    <>
      {season.leftBefore > 0 && <p className="help">{things(season.leftBefore)} from an earlier set {season.leftBefore === 1 ? "is" : "are"} still to do. <a href="/season">See the whole season</a></p>}
      {!step && season.steps.length > 0 && asksAnything(season) && (
        <p className="paid-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>You&apos;ve finished every set of {season.name}. Thank you!</p>
      )}
    </>
  );
}
