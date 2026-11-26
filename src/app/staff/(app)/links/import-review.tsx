import Link from "next/link";
import { Card, LinkButton, Notice } from "@/app/components/ui";
import { GUARDIAN_NAMED, IMPORT_MAX, type ImportProposal, type NotProposedGuardian, type ProposedFamily, type ProposedGuardian } from "@/lib/accounting/import-proposals";
import { importKeys } from "@/lib/accounting/import-proposals";
import { importStamp } from "@/lib/accounting/stamp";
import { saveImportAction } from "./actions";
import { ImportForm, ImportTick } from "./import-form";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listed = (names: readonly string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Where the review is drawn, and the address of the step that draws it (like the confirm step's, by the page's query string). */
export const IMPORT_H = "import-h";
export const IMPORT_STEP = `/staff/links?import=1#${IMPORT_H}`;

/**
 * The reviewed import's words on the page (stage 4's slice M6; the lead's decision 4: every sentence the owner may
 * change, in one place). The press's own words are IMPORT_PRESS (./import-form.tsx); its answers and refusal are
 * IMPORT_COPY (src/lib/accounting/import-writes.ts).
 */
export const IMPORT_WORDS = {
  offer: "Propose families from the books",
  offerLead: (n: number) => `The portal can propose a family, with students and guardians, for ${n === 1 ? "the customer" : `each of the ${n} customers`} here. You look them over before anything is saved. Up to ${IMPORT_MAX} at a time.`,
  offerNeeds: "Someone who may change families can propose families here, since it gives guardians a sign-in.",
  heading: "Propose families from the books",
  needs: "This needs the permission to change families too, since it gives guardians a sign-in.",
  nothing: "No family is proposed now: every customer listed here is one this page links to a family the portal has, or none is listed.",
  intro: (welcomes: boolean) => [
    "This is what the portal would make from the books. Look it over, untick any family you don't want made now, then press the button at the end.",
    welcomes
      ? "Welcome emails are on, so everyone added who hasn't been welcomed gets one, a few at a time."
      : "Welcome emails are off, so nobody is mailed now: each person added who has never been welcomed is welcomed, with a link to set up their sign-in, once an Admin switches welcome emails on.",
    "A family you untick stays in the list of customers with no family, to make later, here or with “Create a family from this”.",
  ],
  /** The rest of the intro, in a hint under it. */
  introMore: "Nothing is sent to QuickBooks, and families, students and people the portal has already are never changed. Each family and student is made linked to its customer, and each guardian is added as on a family's page.",
  aimed: (n: number) => `${plural(n, "customer listed here isn't", "customers listed here aren't")} proposed, as this page suggests ${n === 1 ? "it" : "each"} for, or lists ${n === 1 ? "it" : "each"} as a possible customer of, a family the portal has: ${n === 1 ? "it is" : "they are"} linked on this page instead.`,
  pastCap: (n: number) => `${plural(n, "more customer isn't", "more customers aren't")} proposed yet, as up to ${IMPORT_MAX} are proposed at a time: ${n === 1 ? "it is" : "they are"} proposed here once these are made.`,
  legend: "Families to make",
} as const;

/** Why a customer read for a guardian gives none, in words; nothing of an email field but the address read. */
const NOT_PROPOSED_WORDS: Record<NotProposedGuardian["why"], (n: NotProposedGuardian) => string> = {
  inactive: (n) => `${n.customer}: inactive in the books, so no guardian is added from it.`,
  no_address: (n) => `${n.customer}: no address in its email field the portal can use, so no guardian is added from it.`,
  same_address: (n) => `${n.customer}: its first address, ${n.address}, is ${n.sameAs}'s too, so it gives no second guardian and isn't linked to anyone.`,
  blocked: (n) => `${n.customer}: its address, ${n.address}, is held by someone whose sign-in is blocked, so no guardian is added from it.`,
  name: (n) => `${n.customer}: the portal can't take that name, so no guardian is added from it.`,
};

/** One proposed guardian, in words: name, address, the person, the Parent customer linked or why none, and the other families giving the same address. */
function guardianWords(g: ProposedGuardian): string {
  const who = g.person.kind === "new" ? `${g.name} (${g.email}), a new person`
    : `${g.person.name} (${g.email}), whom the portal has already${g.person.families.length === 0 ? "" : `, a guardian of ${listed(g.person.families)} now`}, added with their name as it is`;
  const link = g.link !== null ? `, linked to the Parent customer “${g.link.name}”`
    : g.linkNot === "taken" ? `, not linked to the Parent customer “${g.customer}”, as another link names it or keeps it`
    : g.linkNot === "held" ? `, not linked to the Parent customer “${g.customer}”, as a change for it waits on Reconciliation`
    : "";
  const also = g.alsoIn.length === 0 ? "" : ` The same address is proposed for ${listed(g.alsoIn)} too: one person, a guardian of each.`;
  return `${who}${link}.${also}`;
}

/** What one family's tick makes: its students made and left alone, its guardians, and the customers that give none. */
function FamilyShown({ f }: { f: ProposedFamily }) {
  const { made, leftAlone } = f.students;
  return (
    <div className="stack">
      <ImportTick id={f.customerId} name={f.name} />
      <p>{made.length === 0 ? "No student is made." : `Students made, each linked to their own: ${made.map((s) => `${s.name}${s.active ? "" : " (inactive in the books, and here)"}`).join(", ")}.`}
        {leftAlone.length > 0 && ` Left as they are, as the portal has a record of them already: ${leftAlone.map((s) => s.name).join(", ")}.`}</p>
      {f.guardians.length === 0 ? <p>No guardian is added.</p> : <><p>Guardians added:</p><ul>{f.guardians.map((g) => <li key={g.email}>{guardianWords(g)}</li>)}</ul></>}
      {f.notProposed.length > 0 && <ul>{f.notProposed.map((n, i) => <li key={i}>{NOT_PROPOSED_WORDS[n.why](n)}</li>)}</ul>}
      {f.unusable > 0 && <p>{plural(f.unusable, "piece of an email field read here isn't an address", "pieces of the email fields read here aren't addresses")} the portal can use, so {f.unusable === 1 ? "it gives" : "they give"} no guardian.</p>}
    </div>
  );
}

/**
 * The import's offer, at the end of the part for the customers no family is linked to (slice M6): whenever it lists at
 * least one customer this page doesn't aim at a family the portal has (the owner's choice 7: no once-only setting), a
 * link to the review step for a reader who may change families too (the lead's decision 3), or words saying who makes
 * it. Nothing written, nothing read.
 */
export function ImportOffer({ proposable, mayChangeFamilies }: { proposable: number; mayChangeFamilies: boolean }) {
  if (proposable === 0) return null;
  if (!mayChangeFamilies) return <Notice tone="info" live="none">{IMPORT_WORDS.offerNeeds}</Notice>;
  return (
    <>
      <p>{IMPORT_WORDS.offerLead(proposable)}</p>
      <p><LinkButton variant="secondary" href={IMPORT_STEP}>{IMPORT_WORDS.offer}</LinkButton></p>
    </>
  );
}

/**
 * The review step (slice M6), at `?import=1`: each proposed family with its tick (ticked), its students and guardians,
 * then what isn't proposed, with what the press does said first. The press is bound to the roster tag and the stamp
 * sealing the whole list shown (importStamp()); the client form is given only the customer ids, the names it shows, the
 * count and the stamp. Not audited: it shows nothing the list doesn't but the guardians' addresses from the books and
 * the persons who hold them, as the accounting links screen shows its rows (the lead's choice 13). A reader who may
 * not change families is told so, and shown nothing.
 */
export function ImportReview({ review, mayChangeFamilies, tag }: { review: { proposal: ImportProposal; welcomes: boolean } | null; mayChangeFamilies: boolean; tag: string }) {
  const body = () => {
    if (!mayChangeFamilies) return <Notice tone="info" live="none">{IMPORT_WORDS.needs}</Notice>;
    if (review === null) return <Notice tone="info" live="none">{IMPORT_WORDS.nothing}</Notice>;
    const { proposal, welcomes } = review;
    const left = [proposal.aimed > 0 ? IMPORT_WORDS.aimed(proposal.aimed) : null, proposal.pastCap > 0 ? IMPORT_WORDS.pastCap(proposal.pastCap) : null].filter((x) => x !== null);
    if (proposal.families.length === 0) return <>{<Notice tone="info" live="none">{IMPORT_WORDS.nothing}</Notice>}{left.map((w) => <p key={w}>{w}</p>)}</>;
    const stamp = importStamp(importKeys(proposal.families));
    return (
      <div className="stack">
        {IMPORT_WORDS.intro(welcomes).map((w) => <p key={w}>{w}</p>)}
        <p className="hint">{IMPORT_WORDS.introMore}</p>
        <p>{GUARDIAN_NAMED[proposal.from]}</p>
        <ImportForm ids={proposal.families.map((f) => f.customerId)} act={saveImportAction.bind(null, tag, stamp)}>
          <fieldset className="checks"><legend>{IMPORT_WORDS.legend}</legend>
            {proposal.families.map((f) => <FamilyShown key={f.customerId} f={f} />)}
          </fieldset>
        </ImportForm>
        {left.length > 0 && <Notice tone="info" live="none">{left.join(" ")}</Notice>}
      </div>
    );
  };
  return (
    <Card title={IMPORT_WORDS.heading} titleId={IMPORT_H}>
      {body()}
      <p className="link-line"><Link href="/staff/links">Close</Link></p>
    </Card>
  );
}
