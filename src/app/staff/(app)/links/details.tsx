"use client";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";
import { DrawerLink } from "@/app/components/ui/sheet";
import type { DetailMark, LinkDetails } from "@/lib/accounting/link-details";

/**
 * Show details on Accounting links (the owner's one exception to "no fold-outs", approved 2026-11-27): a button in the
 * row (`aria-expanded`, `aria-controls`, its words turning to Hide details) that opens the row in place into two
 * columns, the family in the portal and its record in the books, each item marked Matched, Differs or Only in your
 * books in words with an icon. Nothing of it is in the page: the first open asks the server for that one family
 * (`load`, the bound Show details action, which audits the read), and the answer is kept while the page stays. It holds
 * no action but the way to the family's Review drawer; the row's main press stays on the row.
 */
type Answer = { ok: true; details: LinkDetails } | { ok: false; errors: string[] };
type Shared = {
  open: ReadonlySet<string>; answers: ReadonlyMap<string, Answer>; pending: ReadonlySet<string>;
  toggle: (familyId: string) => void;
};
const Ctx = createContext<Shared>({ open: new Set(), answers: new Map(), pending: new Set(), toggle: () => {} });

/** The rows' shared state: which are open, and each family's answer once asked for. `load` is the bound Show details action. */
export function LinkDetailsProvider({ load, children }: { load: (familyId: string) => Promise<{ ok: true; message: string; details: LinkDetails } | { ok: false; errors: string[] }>; children: ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [, start] = useTransition();
  const toggle = (familyId: string) => {
    const opening = !open.has(familyId);
    setOpen((had) => { const next = new Set(had); if (opening) next.add(familyId); else next.delete(familyId); return next; });
    if (!opening || answers.get(familyId)?.ok || pending.has(familyId)) return;
    setPending((had) => new Set(had).add(familyId));
    start(async () => {
      const r = await safely(() => load(familyId), { ok: false as const, errors: [ACTION_FAILED] });
      setAnswers((had) => new Map(had).set(familyId, r.ok ? { ok: true, details: r.details } : { ok: false, errors: r.errors }));
      setPending((had) => { const next = new Set(had); next.delete(familyId); return next; });
    });
  };
  return <Ctx.Provider value={{ open, answers, pending, toggle }}>{children}</Ctx.Provider>;
}

const panelId = (familyId: string) => `links-more-${familyId}`;

const CHEVRON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>;

/** The row's Show details button. Its accessible name names the family too. */
export function DetailsToggle({ familyId, family }: { familyId: string; family: string }) {
  const { open, toggle } = useContext(Ctx);
  const isOpen = open.has(familyId);
  return (
    <button type="button" className="btn btn-text btn-sm links-toggle" aria-expanded={isOpen} aria-controls={panelId(familyId)} onClick={() => toggle(familyId)}>
      {isOpen ? "Hide details" : "Show details"}<span className="visually-hidden">: {family}</span>{CHEVRON}
    </button>
  );
}

const MARK_WORDS: Record<DetailMark, string> = { matched: "Matched", differs: "Differs", only_books: "Only in your books" };
const MARK_ICON: Record<DetailMark, ReactNode> = {
  matched: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.8 8.3l2.1 2.1 4.3-4.5" fill="none" stroke="var(--mark-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  differs: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h10M3 10h10M10 3.5l-4 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  only_books: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="2.4 2.3" /></svg>,
};
function Mark({ mark }: { mark: DetailMark | null }) {
  if (mark === null) return null;
  return <span className={`links-mark links-mark-${mark}`}>{MARK_ICON[mark]}{MARK_WORDS[mark]}</span>;
}

/**
 * The row's expansion: drawn hidden until its row is opened, then the two records side by side, one line of what
 * the row's main press would link, and the button to the family's Review drawer (where the screen has one for it).
 */
export function DetailsPanel({ familyId, family, review, nouns }: { familyId: string; family: string; review: boolean; nouns: { one: string; many: string } }) {
  const { open, answers, pending } = useContext(Ctx);
  const isOpen = open.has(familyId);
  const answer = answers.get(familyId);
  return (
    <div id={panelId(familyId)} className="links-more" hidden={!isOpen} role="region" aria-label={`Details: ${family}`}>
      {isOpen && (answer === undefined || pending.has(familyId) ? <p className="hint" aria-live="polite">Loading the details…</p>
        : !answer.ok ? <ActionOutcome state={answer} />
        : <Compared d={answer.details} nouns={nouns} />)}
      {isOpen && (
        <div className="links-more-foot">
          <span>{answer?.ok ? answer.details.confirms : null}</span>
          {review && <DrawerLink param="review" value={familyId} variant="text">Review {family}</DrawerLink>}
        </div>
      )}
    </div>
  );
}

function Compared({ d, nouns }: { d: LinkDetails; nouns: { one: string; many: string } }) {
  return (
    <div className="links-cmp">
      <section aria-label="In the portal">
        <h4>In the portal</h4>
        <p className="links-cmp-name">{d.family}</p>
        <dl>
          <dt>Guardians</dt>
          <dd>{d.portal.guardians.length === 0 ? "None yet" : d.portal.guardians.map((g, i) => (
            <div key={i}><b>{g.name}</b> · {g.email}<Mark mark={g.emailMark} />{g.blocked ? " · can't sign in" : ""} · {g.phone ?? "no phone"}<Mark mark={g.phoneMark} /></div>
          ))}</dd>
          <dt>Students</dt>
          <dd>{d.portal.students.length === 0 ? "None active" : d.portal.students.map((s, i) => <div key={i}>{s.name}<Mark mark={s.mark} /></div>)}</dd>
        </dl>
      </section>
      <section aria-label="In your books">
        <h4>In your books</h4>
        {d.books === null ? <p>{d.possible.length > 0 ? `${d.possible.length} ${d.possible.length === 1 ? nouns.one : nouns.many} in your books hold a guardian's email: ${d.possible.join(", ")}.` : `No ${nouns.one} in your books is linked or suggested.`}</p> : (
          <>
            <p className="links-cmp-name">{d.books.name}</p>
            <dl>
              <dt>Email</dt><dd>{d.books.email ?? "None"}<Mark mark={d.books.emailMark} /></dd>
              <dt>Phone</dt><dd>{d.books.phone ?? "None"}<Mark mark={d.books.phoneMark} /></dd>
              <dt>Under it</dt>
              <dd>{d.books.under.length === 0 ? "Nothing" : d.books.under.map((c, i) => (
                <div key={i}>{c.name}{c.kind || !c.active ? ` · ${[c.kind, c.active ? null : "inactive"].filter(Boolean).join(", ")}` : ""}<Mark mark={c.mark} /></div>
              ))}</dd>
            </dl>
          </>
        )}
      </section>
    </div>
  );
}
