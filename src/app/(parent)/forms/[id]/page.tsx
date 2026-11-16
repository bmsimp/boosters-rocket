import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { CONSENT_TEXT } from "@/lib/forms/consent";
import { findMyForm } from "@/lib/forms/my-forms";
import { openMyForm, type FormView } from "@/lib/forms/signing";
import { STATE_WORDS } from "@/lib/forms/states";
import { dueState } from "@/lib/money/due";
import { CalendarDate } from "../../../components/calendar-date";
import { StateWords } from "../../../components/state-words";
import { AgreeButton, FinishingNote, SigningFrame, StartAgainButton } from "./signing";

export const metadata = { title: "Form" };
// Every open reads the form's state, and a guardian's own signing token, from Documenso: never from a cache.
export const dynamic = "force-dynamic";

const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Who the document was made for, and who has signed: the family's own guardians, by name. */
function Signers({ signers }: { signers: FormView["signers"] }) {
  if (signers.length === 0) return null;
  return (
    <ul className="reqs signers">{signers.map((s, i) => (
      <li key={i}><span className="what">{s.name}{s.you ? " (you)" : ""}</span><StateWords state={s.signed ? "done" : "todo"} words={s.signed ? "Has signed" : "Hasn't signed yet"} /></li>
    ))}</ul>
  );
}

/**
 * One form, for the signed-in guardian to read and sign (v1 spec §9.2).
 *
 * The id in the address is untrusted: findMyForm() looks it up within the session's family and among the forms that
 * family's season asks for, and anything else answers 404, the same as an id that doesn't exist.
 *
 * Before the guardian has agreed to sign electronically, the page shows the consent text and nothing has been made
 * or read in Documenso. After it, the page shows Documenso's signing frame: its address holds this guardian's own
 * signing token, read from Documenso as the page is drawn, never stored, and sent to nobody else.
 */
export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireParentPage(`/forms/${id}`);
  const form = await findMyForm(ctx, id);
  if (!form) notFound();
  const view = await openMyForm(ctx, form);
  const { step } = view;
  // A waiver is the club's word on the requirement; the form's own state is said beside it only when it was signed.
  const waived = form.line.state === "waived" && step.kind !== "complete";
  // The same words as the Forms list: "not ready" only for a form nothing has been made for yet.
  const stateWords = step.kind === "not_ready" && form.row.state === "not_opened" ? STATE_WORDS.notReady : view.words;
  const due = form.line.dueOn && step.kind !== "complete" && !waived ? dueState(form.line.dueOn, form.today) : null;
  const others = view.signers.filter((s) => !s.signed && !s.you).map((s) => s.name);
  return (
    <main className="wrap single forms-page">
      <h1 className="page-title">{form.line.title}</h1>
      <p className="lede">{form.subject.who === "student" ? <>For {form.subject.name}</> : <>For your family, {form.subject.name}</>} · {form.stepName} · <Link href="/forms">Back to Forms</Link></p>

      <section className="box" aria-labelledby="form-h">
        <h2 id="form-h">{step.kind === "complete" ? "Signed" : step.kind === "consent" ? CONSENT_TEXT.heading : "This form"}</h2>
        {waived ? <StateWords state="waived" words={form.line.words} />
          : <StateWords state={step.kind === "complete" ? "done" : "todo"} words={stateWords} />}
        {due && <p className="help">{due.lead} <CalendarDate iso={form.line.dueOn!} />{due.tail}</p>}

        {step.kind === "not_ready" && <p className="help">The club is still getting this form ready. There&apos;s nothing you need to do right now: it will be here to sign when it is.</p>}

        {step.kind === "consent" && (
          <div className="consent">
            {CONSENT_TEXT.paragraphs.map((p) => <p key={p}>{p}</p>)}
            <AgreeButton requestId={form.row.id} label={CONSENT_TEXT.agree} />
          </div>
        )}

        {step.kind === "sign" && <SigningFrame requestId={form.row.id} frameUrl={step.frameUrl} origin={step.origin} title={form.line.title} />}

        {step.kind === "waiting" && (
          <p className="help">{step.signedByYou ? "Thank you, you've signed. " : ""}{others.length > 0
            ? <>It still needs {listed(others)} to sign. They can sign it from their own Forms page.</>
            : <>It still needs another guardian to sign.</>}</p>
        )}

        {step.kind === "sealing" && (
          <>
            <p className="help">Everyone has signed. The signed copy is being finished, which usually takes a few seconds. You don&apos;t need to do anything more.</p>
            <FinishingNote requestId={form.row.id} />
          </>
        )}

        {step.kind === "complete" && (
          <p className="paid-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>This form is signed. Thank you!</p>
        )}

        {step.kind === "declined" && (
          <>
            <p className="help">This form was declined, so it isn&apos;t signed. {step.canRestart ? "If that wasn't meant, you can start it again and sign it." : "If that wasn't meant, ask the club and they'll help."}</p>
            {step.canRestart && <StartAgainButton requestId={form.row.id} />}
          </>
        )}

        {step.kind === "unavailable" && (
          <>
            <p className="help" role="status">We can&apos;t show this form right now. Nothing is lost. Please try again in a few minutes.</p>
            <div className="box-foot"><a className="btn btn-line" href={`/forms/${form.row.id}`}>Try again</a></div>
          </>
        )}

        <Signers signers={view.signers} />
      </section>
    </main>
  );
}
