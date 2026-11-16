import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { firstName } from "@/lib/parents/first-name";
import { loadMyForms, type MyFormGroup, type MyFormLine } from "@/lib/forms/my-forms";
import { STATE_WORDS } from "@/lib/forms/states";
import { dueState } from "@/lib/money/due";
import { getClubSettings } from "@/lib/settings/club";
import { CalendarDate } from "../../components/calendar-date";
import { StateWords } from "../../components/state-words";
import { NotSetUpBox } from "../family-boxes";

export const metadata = { title: "Forms" };

const TONE = { later: "when", soon: "when soon", late: "when late" } as const;

/** What the link to a form says: it names the person a form is signed for, as the buttons on Home do. */
function linkWords(group: MyFormGroup, form: MyFormLine): string {
  const signing = form.line.state === "todo" && form.line.words === STATE_WORDS.notSigned;
  if (!signing) return "Open";
  return group.who === "student" ? `Sign for ${firstName(group.name) || group.name}` : "Sign";
}

/** One form: its title and the set it belongs to, its state in words, when it is due, and the way to it. */
function FormLine({ group, form, today }: { group: MyFormGroup; form: MyFormLine; today: string }) {
  const { line } = form;
  const due = line.dueOn ? dueState(line.dueOn, today) : null;
  // A form that can't be opened yet has no link: there is nothing behind it. An address of a form never holds a
  // QuickBooks id: it is the portal's own id for the family's request. A plain link, not next/link: opening a form
  // makes its document and reads Documenso, which must happen when a guardian asks for it and never ahead of time.
  const canOpen = form.requestId !== null && line.words !== STATE_WORDS.notReady;
  return (
    <li>
      <span className="what">{line.title}{!line.required && <span className="optional"> (optional)</span>}</span>
      <span className="when">{form.stepName}</span>
      <StateWords state={line.state} words={line.words} />
      {due && <span className={TONE[due.tone]}>{due.lead} <CalendarDate iso={line.dueOn!} />{due.tail}</span>}
      {canOpen && <a className="btn btn-club form-open" href={`/forms/${form.requestId}`}>{linkWords(group, form)}<span className="visually-hidden">: {line.title}</span></a>}
    </li>
  );
}

/**
 * This season's forms for the signed-in family: for the family itself and for each student, every form with how it
 * stands, in words. The family comes from the session and nothing else. Until the club has set forms up, the page
 * says so calmly and asks nothing of the parent.
 */
export default async function FormsPage() {
  const ctx = await requireParentPage("/forms");
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  const forms = family ? await loadMyForms(ctx, family) : null;
  return (
    <main className="wrap single forms-page">
      <h1 className="page-title">Forms</h1>
      {!family ? <NotSetUpBox treasurerEmail={club.treasurerEmail} />
        : !forms || forms.groups.length === 0 ? <p className="lede">There are no forms for {family.name} to sign right now. There&apos;s nothing you need to do.</p>
        : (
          <>
            <p className="lede">{forms.seasonName}: the forms for {family.name}, and where each one stands.</p>
            {!forms.ready && <p className="help" role="status">The club&apos;s forms aren&apos;t ready to sign yet. There&apos;s nothing you need to do right now: they&apos;ll show up here when they are.</p>}
            {forms.groups.map((group, i) => (
              <section className="box" key={group.subjectQboId} aria-labelledby={`forms-${i}`}>
                <h2 id={`forms-${i}`}>{group.who === "family" ? "Your family" : group.name}</h2>
                {group.who === "family" && <p>Signed once for {group.name}</p>}
                <ul className="reqs">{group.forms.map((form) => <FormLine key={form.line.requirementId} group={group} form={form} today={forms.today} />)}</ul>
              </section>
            ))}
          </>
        )}
    </main>
  );
}
