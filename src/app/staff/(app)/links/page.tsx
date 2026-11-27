import Link from "next/link";
import type { ReactNode } from "react";
import { requireStaffAlso, requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { filterLinkRows, filtersOf, givenUpCustomersOf, loadAccountingLinks, REVIEW_LEFT_WORDS, SEND_ALL_MAX, statusCounts, type ConfirmStep, type GuardianSendOffer, type GuardianShown, type InactiveRow, type KeptOffer, KEPT_ASK, KEPT_GONE, KEPT_GONE_ASK, type LinkMade, type LinkOffer, type LinkRow, type LinkStatus, type LinksState, type LinksView, type OwnLink, type SendAllOffer, type SendOffer, type TakeOffer } from "@/lib/accounting/mapping";
import { differenceWords, guardianDifferenceNext, noteSentence, type Difference } from "@/lib/accounting/differences";
import { NOT_A_FAMILY_WORDS, parseLinksFilter, searchMatches, SEARCH_MAX, STATUS_KEYS, STATUS_WORDS, type LinksFilter, type StatusKey } from "@/lib/accounting/status";
import { accountingWords, capitalized, type AccountingWords } from "@/lib/accounting/words";
import type { Holder } from "@/lib/accounting/match";
import type { Proposals } from "@/lib/accounting/proposals";
import { recordNameWords } from "@/lib/families/words";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { Button, BulkResults, BulkSelect, Card, DataTable, Drawer, EmptyState, LinkButton, LocalTime, Notice, PageHeader, Select, StatusBadge, TextInput, Toolbar, type Column, type Tone } from "@/app/components/ui";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { IntegrationLogo } from "@/app/staff/(app)/settings/integration-logo";
import { confirmLinkAction, leaveUnlinkedAction, linkDetailsAction, linkGuardianAction, linkSuggestedManyAction, reviewLinkAction, sendAllAction, sendDifferenceAction, takeDifferenceAction, undoLeaveUnlinkedAction, unlinkAction, unlinkGuardianAction } from "./actions";
import { GuardianLinkPress, LinkAnswers, LinkAnswersShown, LinkGiveUp, LinkPress, LinkUnlink } from "./link-press";
import { giveUpAction } from "../roster/write-actions";
import { CustomersWithNoFamily } from "./no-family";
import { ImportOffer, ImportReview } from "./import-review";
import { LinkSuggestedBulk, type SuggestedPick } from "./bulk-presses";
import { DetailsPanel, DetailsToggle, LinkDetailsProvider } from "./details";

export const metadata = { title: "Accounting links" };
export const dynamic = "force-dynamic";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be suggested now, in words. Differences aren't checked in any of these states either. */
const whyNotChecked = (w: AccountingWords): Record<Exclude<LinksState, "listed">, string> => ({
  no_company: "The portal hasn't read the books yet, so links, suggestions and differences can't be checked. Each family shows as not checked.",
  other_company: `${w.name} is connected to a different company from the roster's, so links, suggestions and differences can't be checked. Each family shows as not checked. An Admin can see why under Settings, ${w.name}.`,
  no_shape: `The membership shape isn't chosen, or names a ${w.customerNoun} type the books no longer have, so the portal can't tell which ${w.customerNounPlural} are families. Links show as they are, but nothing is suggested or checked. An Admin can choose the shape under Settings, ${w.name}.`,
});

/** The tone a status label carries with its words: a link that stands, something to look at, or nothing checked or wanted. */
const TONE: Record<StatusKey, Tone> = {
  carried_over: "done", linked: "done", with_differences: "due", suggested: "due", several: "due", no_match: "due", left_unlinked: "neutral", not_a_family: "due", customer_gone: "due", not_checked: "neutral",
};

/** The row's status label, its words saying how the family matched: "Suggested by email", "Linked, 2 differ", "2 possible". */
function statusWords(row: LinkRow): string {
  const s = row.status;
  if (s.key === "with_differences") return `Linked, ${row.differences.length} ${row.differences.length === 1 ? "differs" : "differ"}`;
  if (s.key === "several") return `${s.candidates.length} possible`;
  return STATUS_WORDS[s.key];
}

/** At most this many records are listed at once in the chooser; a search narrows them. */
const CHOOSER_MAX = 50;

const holderWords = (h: Holder) => (h.on.kind === "family" ? `${h.address}, on this record` : `${h.address}, on ${h.on.name} under it`);

/** How a link was made, in words: carried over from the roster, or by whose press. */
function MadeDetail({ made }: { made: LinkMade }) {
  return made.key === "carried_over" ? <>Carried over from the roster by the portal, on <LocalTime iso={made.at} />. Nobody has confirmed it since.</>
    : made.origin === "confirmed" ? <>Confirmed{made.by ? ` by ${made.by}` : ""}, on this page or with &ldquo;Create a family&rdquo;, on <LocalTime iso={made.at} />.</>
    : <>Made in the books from the portal{made.by ? ` by ${made.by}` : ""}, on <LocalTime iso={made.at} />.</>;
}

/** Why the row stands as it does, in one sentence, at the top of its Review drawer. Every name and address is the books' text or a person's, shown as text. */
function StatusDetail({ status, row, w }: { status: LinkStatus; row: LinkRow; w: AccountingWords }) {
  switch (status.key) {
    case "carried_over": case "linked": return <MadeDetail made={status} />;
    case "with_differences": return <><MadeDetail made={status.made} /> The portal and the books differ in {plural(row.differences.length, "place", "places")}, each listed here with what settles it.</>;
    case "customer_gone": return <>The {w.customerNoun} this family is linked to isn&apos;t in the books&apos; copy any more. The link is kept as it is.</>;
    case "not_a_family": return <>The linked {w.customerNoun} is still in the books, but isn&apos;t a family there now: {status.reasons.map((r) => NOT_A_FAMILY_WORDS[r]).join("; ")}. The link is kept as it is.</>;
    case "suggested": return <>A guardian&apos;s sign-in email is on it: {status.holders.map(holderWords).join("; ")}.</>;
    case "several": return status.why === "many"
      ? <>More than one {w.customerNoun} with no family holds a guardian&apos;s sign-in email, so none is filled in.</>
      : <>The one {w.customerNoun} that holds a guardian&apos;s sign-in email also holds an address of {status.alsoMatches.length === 1 ? "another family's guardian" : "other families' guardians"}, so it isn&apos;t filled in for any of them.</>;
    case "no_match": return status.noGuardians
      ? <>This family has no guardians yet, so there is no email to match.</>
      : row.addresses.length === 0 ? <>None of this family&apos;s guardians can sign in, so there is no email to match.</>
      : <>No {w.customerNoun} with no family holds any of its guardians&apos; sign-in emails.</>;
    case "left_unlinked": return <>Left unlinked{status.by ? ` by ${status.by}` : ""}, on <LocalTime iso={status.at} />.</>;
    case "not_checked": return <>The books can&apos;t be checked now, so nothing is suggested.</>;
  }
}

/** A student's or guardian's own link, in words. */
const ownLinkWords = (l: OwnLink, w: AccountingWords) => (l.state === "linked" ? `linked to ${l.customer}` : l.state === "gone" ? `linked to a ${w.customerNoun} that isn't in the books' copy any more`
  : l.state === "none" ? "no link of its own" : "its link can't be checked now");

const listed = (names: readonly string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * How an open guardian row's own link stands (slice M3c), in words, after ownLinkWords(): their own Parent customer
 * (what the portal sends to), one shared with another guardian, one elsewhere in the books, or one the books' copy
 * doesn't hold. Nothing is sent for any but their own (ownParentCustomer(), src/lib/roster/writes.ts).
 */
function standingWords(g: GuardianShown): string {
  switch (g.standing) {
    case null: return "";
    case "own": return ", their own parent record";
    // Only a Parent customer directly under this family's customer is `shared` (guardianLinkOf()): one guardian of this family left on it alone is theirs.
    case "shared": return g.sharedWith.length === 0 ? ", shared with another guardian here, so nothing is sent for them"
      : `, shared with a guardian of ${listed(g.sharedWith)}, so nothing is sent for them`;
    case "elsewhere": return ", not under this family's record, so nothing is sent for them";
    case "gone": return ", so nothing is sent for them";
  }
}

/** What Link this guardian does, said beside every one (linkGuardian(), src/lib/accounting/guardian-links.ts). */
const GUARDIAN_LINK_EFFECT = "Their later changes go to this parent record.";
/**
 * What Unlink this guardian does, as a warning beside every one (unlinkGuardian()): a change of their details refuses
 * it nothing (a waiting one is given up at its next try, a stuck or kept one stays on Reconciliation). The press is
 * drawn only while nothing on the queue holds it back (`unlinkHeld`), so the warning needn't say what does.
 */
const GUARDIAN_UNLINK_EFFECT = (who: string) => `Nothing more is sent for ${who}, and a change of theirs still waiting is dropped.`;

/** Reconciliation's list of changes, where a change the queue holds is shown with what can be done about it. */
const RECONCILIATION_CHANGES = "/staff/reconciliation#writes-h";
/** What on the write queue holds Link this guardian back (GuardianShown.linkHeld), in words; null for nothing. */
function linkHeldWords(g: GuardianShown): string | null {
  const h = g.linkHeld;
  if (h === null) return null;
  if (h.row > 0) return `Link ${g.name} once ${h.row === 1 ? "their change on Reconciliation is" : `their ${h.row} changes on Reconciliation are`} done.`;
  return `Link ${g.name} once ${h.customers === 1 ? "a parent record's change on Reconciliation is" : `${h.customers} parent records' changes on Reconciliation are`} done.`;
}
/** What on the write queue holds Unlink this guardian back (GuardianShown.unlinkHeld), in words. */
const unlinkHeldWords = (g: GuardianShown) => `Unlink ${g.name} once ${g.unlinkHeld === 1 ? "their parent record's change on Reconciliation is" : `their parent record's ${g.unlinkHeld} changes on Reconciliation are`} done.`;

/** Whether a guardian's line has anything to do or wait for in the Review drawer. */
const guardianActs = (g: GuardianShown) => g.offer !== null || g.unlink !== null || g.linkHeld !== null || g.unlinkHeld > 0 || g.noOffer !== null;

/** One open guardian of the Review drawer (since slice M3c with its link's standing, Link this guardian or Unlink this guardian). */
function GuardianLine({ g, row, tag, w }: { g: GuardianShown; row: LinkRow; tag: string; w: AccountingWords }) {
  return (
    <li>{g.name} ({g.email}){g.blocked ? ", can't sign in, so this email isn't matched" : ""}: {ownLinkWords(g.link, w)}{standingWords(g)}
      {g.offer !== null && (
        <>
          <p>{g.offer.suggested !== null ? `The likely match for ${g.name} is filled in.` : `Choose ${g.name}'s parent record.`}</p>
          <GuardianLinkPress name={`guardian-${g.id}`} who={g.name} about={row.name} suggested={g.offer.suggested}
            options={g.offer.candidates.map((c) => ({ value: c.qboId, label: c.name, hint: c.email ?? "No email address",
              act: linkGuardianAction.bind(null, g.id, c.qboId, c.qboId === g.offer!.suggested ? "suggested" : "picked", tag, g.offer!.stamps[c.qboId]!) }))} />
          <p>{GUARDIAN_LINK_EFFECT}</p>
        </>
      )}
      {linkHeldWords(g) !== null && <p>{linkHeldWords(g)} <Link href={RECONCILIATION_CHANGES}>See the changes on Reconciliation<span className="visually-hidden">: {g.name}</span></Link></p>}
      {g.unlinkHeld > 0 && <p>{unlinkHeldWords(g)} <Link href={RECONCILIATION_CHANGES}>See the changes on Reconciliation<span className="visually-hidden">: {g.name}</span></Link></p>}
      {g.noOffer !== null && <p>{g.noOffer.why === "elsewhere" ? `Their record in the books is under ${g.noOffer.family}.` : "No free parent record under this family to link."}</p>}
      {g.unlink !== null && (
        <>
          <Notice tone="warning" live="none">{GUARDIAN_UNLINK_EFFECT(g.name)}</Notice>
          <div className="row-actions"><LinkPress label={`Unlink ${g.name} from this parent record`} busy="Unlinking…" about={row.name} act={unlinkGuardianAction.bind(null, g.id, g.unlink.linkId, tag, g.unlink.stamp)} /></div>
        </>
      )}
    </li>
  );
}

/**
 * One difference, with both values as text, and the change on the write queue that explains it, in the queue's own
 * words with a link to Reconciliation's list (never its buttons). Since slice M4a, where a press takes the books' value
 * into the portal (`take`), what it does is said after it, then the press; or, where none is offered now, why, in one
 * sentence (`note`). Since slice M5c, a change kept in the portal that the difference explains (`kept`, keptOnLinksOf())
 * is said here in its own words in place of the queue's note and its link (it is on Reconciliation's list too), and
 * its Give up is drawn beside the Take and the Send, whose Send closes it; a reader who may not change families is
 * told who settles it, and where (KEPT_ASK).
 */
function DifferenceLine({ d, take, note, send, sendNote, kept, tag }: { d: Difference; take: TakeOffer | undefined; note: string | undefined; send: SendOffer | GuardianSendOffer | undefined;
  sendNote: string | undefined; kept: KeptOffer | undefined; tag: string }) {
  const w = differenceWords(d);
  const notes = kept !== undefined ? [] : d.kind === "guardians_unlinked" ? d.queue.map((q) => `For ${q.count} of them: ${noteSentence(q.note)}`)
    : d.kind === "student_customer" || d.kind === "parent_customers" || d.queue === null ? [] : [noteSentence(d.queue)];
  return (
    <li>{w.what}. In the portal: {w.portal}. In the books: {w.books}.
      {notes.length > 0 && <> {notes.join(" ")} <Link href={RECONCILIATION_CHANGES}>{notes.length === 1 ? "See the change on Reconciliation" : "See the changes on Reconciliation"}</Link></>}
      {guardianDifferenceNext(d) !== null && <>{notes.length > 0 && "."} {guardianDifferenceNext(d)}</>}
      {kept !== undefined && <> {kept.giveUp ? kept.words : `${kept.words} ${KEPT_ASK}`}</>}
      {note !== undefined && <> {note}</>}
      {sendNote !== undefined && <> {sendNote}</>}
      {take !== undefined && <p>{take.words.join(" ")}</p>}
      {send !== undefined && <p>{send.words.join(" ")}</p>}
      {(take !== undefined || send !== undefined || kept?.giveUp === true) && <div className="row-actions">
        {take !== undefined && <TakePress take={take} tag={tag} />}
        {send !== undefined && <SendPress send={send} tag={tag} />}
        {kept !== undefined && kept.giveUp && <GiveUpPress kept={kept} about={send?.about ?? take?.about ?? w.what} />}</div>}</li>
  );
}

/**
 * Give up, for a change kept in the portal (slice M5c): the same press as Reconciliation's (giveUpAction(), today's
 * giveUp(), its permission and its audit row), given only its words (and whom it is about, read out) and the bound
 * action. Its answer is kept above the list with every other press's (LinkGiveUp).
 */
function GiveUpPress({ kept, about }: { kept: KeptOffer; about: string }) {
  return <LinkGiveUp about={about} act={giveUpAction.bind(null, kept.itemId)} />;
}

/** A change kept in the portal that the roster's copy of the books has already (slice M5c, `at` null): its words, why nothing is sent, and Give up. */
function KeptGoneLine({ kept, about }: { kept: KeptOffer; about: string }) {
  return <li>{kept.words} {kept.giveUp ? KEPT_GONE : KEPT_GONE_ASK}{kept.giveUp && <div className="row-actions"><GiveUpPress kept={kept} about={about} /></div>}</li>;
}

/** Take the books' value (slice M4a): the press, a bound action given only its words. */
function TakePress({ take, tag }: { take: TakeOffer; tag: string }) {
  return <LinkPress label="Take the books' value" busy="Taking it…" about={take.about} act={takeDifferenceAction.bind(null, take.field, take.kind, take.recordId, tag, take.stamp)} />;
}

/**
 * Send the portal's value to the books (slice M5a): the press, a bound action given only its words. It reads the books
 * first (a make-inactive's balance, or a change's answer) and sends, so its busy words say both, as Reconciliation's do.
 */
function SendPress({ send, tag }: { send: SendOffer | GuardianSendOffer; tag: string }) {
  return <LinkPress label="Send the portal's value to the books" busy="Reading the books, then sending…" about={send.about} act={sendDifferenceAction.bind(null, send.field, send.kind, send.recordId, tag, send.stamp)} />;
}

/**
 * The inactive families the books have active (slice M4b), after the list, in the Families list's compact style: each
 * family by name (a link to its page while those stand), its match in the books (the books' text, as text) with its
 * inactive students, and Take the books' value making it active again with what it does said beside it, or the one
 * sentence that stands in its place. Drawn only when there is one. Since slice M5c the family's own make-inactive kept
 * in the portal (`kept`) is said first, with its Give up beside the Take and the Send.
 */
function InactivePart({ rows, tag, familyPages, maySend }: { rows: InactiveRow[]; tag: string; familyPages: boolean; maySend: boolean }) {
  const columns: Column<InactiveRow>[] = [
    { key: "family", header: "Family", rowHeader: true, cell: (r) => (familyPages ? <Link href={familyPage(r.familyId)}>{r.name}</Link> : r.name) },
    { key: "match", header: "Match in your books", cell: (r) => <><span className="links-match"><span className="links-who">{r.customer}</span><StatusBadge tone="due">Active there</StatusBadge></span>
      <span className="when">{r.students.length === 0 ? "No students here" : `Inactive here: ${r.students.join(", ")}`}</span></> },
    { key: "do", header: "Actions", quiet: true, cell: (r) => {
      const send = maySend ? r.send : null;
      const kept = r.kept;
      return <>{kept !== null && <p>{kept.giveUp ? kept.words : `${kept.words} ${KEPT_ASK}`}</p>}{r.take === null && <p>{r.note}</p>}{r.take !== null && <p>{r.take.words.join(" ")}</p>}
        {send !== null ? <p>{send.words.join(" ")}</p> : maySend && r.sendNote !== null && <p>{r.sendNote}</p>}
        {(r.take !== null || send !== null || kept?.giveUp === true) && <div className="row-actions">
          {r.take !== null && <TakePress take={r.take} tag={tag} />}
          {send !== null && <SendPress send={send} tag={tag} />}
          {kept !== null && kept.giveUp && <GiveUpPress kept={kept} about={`${r.name}'s active status`} />}</div>}</>;
    } },
  ];
  return (
    <Card title={`Inactive here, active in your books (${rows.length})`} titleId="links-inactive-h"
      description={<>Taking the books&apos; value makes the family active here again and sends nothing. Its guardians can&apos;t sign in until someone who may change families lets them in on its page.</>}>
      <DataTable caption={plural(rows.length, "inactive family the books have active", "inactive families the books have active")} captionHidden columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} />
    </Card>
  );
}

/**
 * What a link press would link with the family, and what it would leave on each side, in words: every pair as "<the
 * record's name> with <the customer's name>", the records and customers left, and that those left aren't linked by it.
 * Since slice M3c2 the guardians it would link, and those the write queue holds back, each with what holds it.
 */
function ProposalsShown({ proposals }: { proposals: Proposals }) {
  const { guardians, guardiansHeld } = proposals;
  return (
    <>
      <StudentProposalsShown proposals={proposals} />
      {guardians.length > 0 && <><p>Guardians linked with it, by the sign-in email on their parent record:</p>
        <ul>{guardians.map((g) => <li key={g.guardianId}>{g.who} with {g.customerName}</li>)}</ul></>}
      {guardiansHeld.length > 0 && <><p>Not linked with it, though their parent record holds their sign-in email:</p>
        <ul>{guardiansHeld.map((g) => <li key={g.guardianId}>{g.who} with {g.customerName}: link them once their change on Reconciliation is done.
          {" "}<Link href={RECONCILIATION_CHANGES}>See the changes on Reconciliation<span className="visually-hidden">: {g.who}</span></Link></li>)}</ul></>}
    </>
  );
}

/** The students a link press would link with the family, and those it would leave (slice M3a). */
function StudentProposalsShown({ proposals }: { proposals: Proposals }) {
  const { pairs, recordsLeft, customersLeft } = proposals;
  if (pairs.length === 0 && recordsLeft.length === 0 && customersLeft.length === 0) return <p>No student would be linked with it.</p>;
  return (
    <>
      <p>{pairs.length === 0 ? "No student would be linked with it: no name is on exactly one student on each side." : "Students linked with it, by name:"}</p>
      {pairs.length > 0 && <ul>{pairs.map((p) => <li key={String(p.studentId)}>{p.recordName} with {p.customerName}{p.customerActive ? "" : " (inactive in the books)"}</li>)}</ul>}
      {recordsLeft.length > 0 && <><p>Left with no link, of the portal&apos;s students:</p><ul>{recordsLeft.map((r) => <li key={String(r.id)}>{recordNameWords(r.name, "student")}</li>)}</ul></>}
      {customersLeft.length > 0 && <><p>Left with no record in the portal, of the students under it in the books:</p><ul>{customersLeft.map((c) => <li key={c.qboId}>{c.name}{c.active ? "" : " (inactive in the books)"}</li>)}</ul></>}
    </>
  );
}

/** What a link does on the parents' side, said once in the Families card and again by each Drawer's Confirm (the owner's decision of 2026-11-27). */
const linkEffect = (customer: string) => `Its guardians will see ${customer}'s invoices, so check it's the right household.`;
/** The rule that stops a wrong link, said once at the top of each Review drawer. */
const safetyRule = (w: AccountingWords) => `A family is suggested only when a guardian's sign-in email is exactly on a ${w.customerNoun}, never by a name. Confirming sends nothing to the books.`;

/** The address of a family's Pick drawer, or of its confirm step for one record. */
const pickHref = (familyId: string, customerId?: string) => `/staff/links?pick=${encodeURIComponent(familyId)}${customerId ? `&customer=${encodeURIComponent(customerId)}` : ""}`;

/** One action of a drawer, and the one sentence a person must know before pressing it. */
function Act({ children, say }: { children: ReactNode; say: ReactNode }) {
  return <div className="links-act">{children}<p className="links-say">{say}</p></div>;
}

/** The match a row shows: the record's name, then the label whose words say how it matched. */
function Match({ row }: { row: LinkRow }) {
  return (
    <span className="links-match">
      {row.customer !== null && <span className="links-who">{row.customer.name}</span>}
      <StatusBadge tone={TONE[row.status.key]}>{statusWords(row)}</StatusBadge>
    </span>
  );
}

/** Whether the screen offers a Review drawer for the row: every row it can say anything about (not a family it can't check). */
const hasReview = (row: LinkRow) => row.status.key !== "not_checked";

/**
 * A family's Review drawer (`?review=<family id>`): the match, one sentence on why, the rule that stops a wrong link,
 * and every other action its status allows, each with its one sentence; for a link that stands, its guardians' links
 * and its differences, each with what settles it. Drawn closed with the page, as every Drawer is; opened by the row's
 * Settle button, or Review at the end of the row's details.
 */
function ReviewDrawer({ row, tag, maySend, w }: { row: LinkRow; tag: string; maySend: boolean; w: AccountingWords }) {
  const id = String(row.familyId);
  const settle = row.status.key === "with_differences";
  const guardians = row.guardians.filter(guardianActs);
  const foot: ReactNode[] = [];
  if (row.confirm !== null && row.customer !== null) foot.push(<Act key="confirm" say={linkEffect(row.customer.name)}><ConfirmPress familyId={id} about={row.name} offer={row.confirm} tag={tag} variant="filled" /></Act>);
  if (row.review !== null) foot.push(<Act key="review" say={<>Marks it as checked by you{row.review.confirms.length > 0 ? `, with ${listed(row.review.confirms.map((c) => c.name))}'s ${row.review.confirms.length === 1 ? "link" : "links"}` : ""}. Nothing is sent.</>}>
    <LinkPress label="Confirm this link" busy="Confirming…" about={row.name} variant={settle ? "outlined" : "filled"} act={reviewLinkAction.bind(null, id, row.review.linkId, tag, row.review.stamp)} /></Act>);
  if (row.offers.pick && row.status.key === "left_unlinked") foot.push(<Act key="pick" say={`Link it to a ${w.customerNoun} no family has.`}><LinkButton variant="filled" href={pickHref(id)}>Pick a {w.customerNoun}<span className="visually-hidden">: {row.name}</span></LinkButton></Act>);
  if (row.offers.leave) foot.push(<Act key="leave" say="Nothing is suggested for it again until someone undoes this or links it."><LinkPress label="Leave unlinked" busy="Leaving it unlinked…" about={row.name} act={leaveUnlinkedAction.bind(null, id, tag)} /></Act>);
  if (row.offers.undo) foot.push(<Act key="undo" say="Suggestions come back for it."><LinkPress label="Undo Left unlinked" busy="Undoing…" about={row.name} act={undoLeaveUnlinkedAction.bind(null, id, tag)} /></Act>);
  if (row.unlink !== null) {
    const ends = `Ends its links to ${row.unlink.customer === null ? `its ${w.customerNoun}` : `“${row.unlink.customer}”`} and to the records under it. Its guardians see no invoices until it's linked again.`;
    foot.push(<Act key="unlink" say={ends}><LinkUnlink about={row.name} consequence={ends} act={unlinkAction.bind(null, id, row.unlink.linkId, tag, row.unlink.stamp)} /></Act>);
  }
  return (
    <Drawer param="review" value={id} trigger={settle} label={<>Settle {plural(row.differences.length, "difference", "differences")}<span className="visually-hidden">: {row.name}</span></>}
      variant="tonal" size="sm" title={`Review ${row.name}`} footer={foot.length > 0 ? foot : undefined} dock>
      <LinkAnswersShown />
      <Match row={row} />
      <p className="sheet-desc"><StatusDetail status={row.status} row={row} w={w} /></p>
      <Notice tone="info" live="none">{safetyRule(w)}</Notice>
      {row.confirm !== null && <ProposalsShown proposals={row.confirm.proposals} />}
      {row.review !== null && row.review.leaves.length > 0 && <><p>Left carried over, as the portal and the books don&apos;t agree on them:</p>
        <ul>{row.review.leaves.map((l) => <li key={l.linkId}>{l.name} ({REVIEW_LEFT_WORDS[l.why]})</li>)}</ul></>}
      {row.status.key === "several" && <><p>Possible {w.customerNounPlural}:</p>
        <ul className="links-acts">{row.status.candidates.map((c) => <li key={c.qboId}>{c.name}{c.email ? ` (${c.email})` : ""}
          <LinkButton variant="tonal" size="sm" href={pickHref(id, c.qboId)}>Look at it before linking<span className="visually-hidden">: {c.name}</span></LinkButton></li>)}</ul>
        {row.status.alsoMatches.length > 0 && <p>Also matched by: {row.status.alsoMatches.join(", ")}.</p>}</>}
      {row.differences.length > 0 && <><h3>Where the portal and the books differ</h3><ul>{row.differences.map((d, i) => <DifferenceLine key={i} d={d} tag={tag} take={row.takes.find((t) => t.at === i)} note={row.takeNotes.find((n) => n.at === i)?.words}
        send={maySend ? row.sends.find((x) => x.at === i) ?? row.guardianSends.find((x) => x.at === i) : undefined} sendNote={maySend ? row.sendNotes.find((n) => n.at === i)?.words : undefined} kept={row.kept.find((k) => k.at === i)} />)}</ul></>}
      {row.kept.some((k) => k.at === null) && <><p>Changes kept in the portal that the roster&apos;s copy of the books has already:</p>
        <ul>{row.kept.filter((k) => k.at === null).map((k) => <KeptGoneLine key={k.itemId} kept={k} about={row.name} />)}</ul></>}
      {row.inactiveUnrecorded > 0 && <p>The books also have {plural(row.inactiveUnrecorded, "inactive student", "inactive students")} under this family with no student record in the portal.</p>}
      {guardians.length > 0 && <><h3>Guardians</h3><ul>{guardians.map((g) => <GuardianLine key={g.id} g={g} row={row} tag={tag} w={w} />)}</ul></>}
      {row.removed.length > 0 && <><p>Removed guardians:</p>
        <ul>{row.removed.map((r) => <li key={r.id}>{r.name}: {r.customer === null ? `linked to a ${w.customerNoun} that isn't in the books' copy any more` : `linked to ${r.customer}, ${r.active ? "active" : "inactive"} in the books`}</li>)}</ul></>}
    </Drawer>
  );
}

/**
 * Send the portal's values for all (slice M5b): for the names and students' families the filter shows now, in the
 * `listed` state, for a reader who may change families, a press bound to the filter as parsed, the count, the roster
 * tag and the stamp sealing those sends, and nothing else; with more than SEND_ALL_MAX, no press but a notice to narrow
 * the list. What it passes over and what it leaves for a later press are said in a notice, with why.
 */
function SendAllPress({ offer, filter, tag }: { offer: SendAllOffer; filter: LinksFilter; tag: string }) {
  const { inactive, booksInactive } = offer.passedOver;
  const said = [
    inactive > 0 ? `It skips ${plural(inactive, "make-inactive", "make-inactives")}: each reads a balance first, so send ${inactive === 1 ? "it" : "each"} from its family's Review.` : null,
    booksInactive > 0 ? `It passes over ${plural(booksInactive, "difference whose record the books have inactive", "differences whose record the books have inactive")}: the portal sends nothing there, and never makes a record active.` : null,
    offer.later > 0 ? `${offer.later === 1 ? "One more difference waits" : `${offer.later} more differences wait`} for a change this press queues to reach the books first, as ${offer.later === 1 ? "it reads" : "they read"} the same record: press again once it has.` : null,
    // Slice M3c4: a guardian's send is never part of it, said only where the list shows one.
    offer.guardians > 0 ? "A guardian's parent record is sent from its family's Review." : null,
  ].filter((x): x is string => x !== null);
  const notes = said.length === 0 ? null : (
    <Notice tone="info" live="none">Send the portal&apos;s values for all sends only names and students&apos; families. {said.join(" ")}{offer.inactiveListed && " The inactive families listed after the families aren't part of it."}</Notice>
  );
  if (offer.count === 0) return notes;
  if (offer.stamp === null) {
    return <>{notes}<Notice tone="info" live="none">This list shows {offer.count} names and students&apos; families to send. Up to {SEND_ALL_MAX} can be sent at once, so narrow the list with the search or a status first.</Notice></>;
  }
  return (
    <div className="stack">
      {notes}
      <p>Queues the portal&apos;s value for each of the {plural(offer.count, "name and student's family", "names and students' families")} shown, as each Send would.
        They go within a few minutes. One the books changed since this page loaded is kept, not sent over, and shows on Reconciliation.
        If the list changes before you press, nothing is queued.</p>
      <div className="row-actions">
        <LinkPress label={`Send the portal's values for all (${offer.count})`} busy="Queueing…" about="Send the portal's values for all"
          act={sendAllAction.bind(null, filter.status ?? "", filter.q, offer.count, tag, offer.stamp)} />
      </div>
    </div>
  );
}

function ConfirmPress({ familyId, about, offer, tag, variant = "outlined", size }: { familyId: string; about: string; offer: LinkOffer; tag: string; variant?: "filled" | "tonal" | "outlined"; size?: "sm" }) {
  return <LinkPress label="Confirm link" busy="Linking…" about={about} variant={variant} size={size} act={confirmLinkAction.bind(null, familyId, offer.customerId, offer.chosen, tag, offer.stamp)} />;
}

/** A Suggested row the bulk press can take: its customer filled in and its own Confirm offered (listed only). */
const pickOf = (r: LinkRow): SuggestedPick | null => (r.status.key !== "suggested" || r.confirm === null || r.customer === null ? null
  : { familyId: String(r.familyId), family: r.name, customer: r.customer.name, customerId: r.confirm.customerId, stamp: r.confirm.stamp });

/**
 * The row's one main action, by its status (the approved table of 2026-11-27): Confirm link (Suggested), Pick a
 * customer (Several possible, No match), Confirm this link (Carried over), Settle N differences (the Review drawer's
 * own button); none for the others, whose actions are in the Review drawer.
 */
function MainAction({ row, tag, w }: { row: LinkRow; tag: string; w: AccountingWords }) {
  const id = String(row.familyId);
  if (row.confirm !== null) return <ConfirmPress familyId={id} about={row.name} offer={row.confirm} tag={tag} variant="tonal" size="sm" />;
  if (row.offers.pick && row.status.key !== "left_unlinked") return <LinkButton variant="tonal" size="sm" href={pickHref(id)}>Pick a {w.customerNoun}<span className="visually-hidden">: {row.name}</span></LinkButton>;
  if (row.review !== null && row.status.key === "carried_over") return <LinkPress label="Confirm this link" busy="Confirming…" about={row.name} variant="tonal" size="sm" act={reviewLinkAction.bind(null, id, row.review.linkId, tag, row.review.stamp)} />;
  return null;
}

/**
 * The Families list, with a box on each Suggested row it shows for the bulk Link to their suggested families (src/lib/bulk.ts),
 * bound to the roster tag: each row ticked is linked by its own Confirm's write, in its own transaction. The page lists
 * every row its filter matches, so ticking the header ticks every Suggested row that matches. With none, no boxes.
 */
function FamiliesTable({ rows, columns, caption, tag, w }: { rows: LinkRow[]; columns: Column<LinkRow>[]; caption: string; tag: string; w: AccountingWords }) {
  const picks = rows.map(pickOf).filter((p): p is SuggestedPick => p !== null);
  const nouns = { one: w.customerNoun, many: w.customerNounPlural };
  const table = (select: boolean) => <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} className="links-table"
    select={select ? { label: (r) => r.name, when: (r) => pickOf(r) !== null } : undefined}
    expand={(r) => <DetailsPanel familyId={String(r.familyId)} family={r.name} review={hasReview(r)} nouns={nouns} />} />;
  if (picks.length === 0) return table(false);
  return (
    <BulkSelect pageIds={picks.map((p) => p.familyId)} noun={{ one: "family", many: "families" }}
      actions={<LinkSuggestedBulk rows={picks} act={linkSuggestedManyAction.bind(null, tag)} />}>
      {table(true)}
    </BulkSelect>
  );
}

/** How the record on the confirm step was chosen, in words. */
const chosenWords = (w: AccountingWords) => ({ suggested: "It is this family's suggestion.", several: `It is one of the ${w.customerNounPlural} that hold a guardian's sign-in email.`, picked: `You picked it from the ${w.customerNounPlural} no family is linked to.` }) as const;

/**
 * Pick a customer for one family (`?pick=<family id>`), as its own Drawer, and the confirm step in it: the records no
 * family is linked to (the pool, by name with its email, searchable), and for the one chosen (`&customer=`), what the
 * press would link and leave. Drawn only for the family the address names, which is parsed here and never trusted: a
 * family the list doesn't offer a pick for, or a record not in the pool, is told in a plain notice. It shows nothing the
 * list doesn't, so it isn't audited.
 */
function PickDrawer({ view, familyId, customerId, cq, tag, made, w }: { view: LinksView; familyId: string; customerId: string | null; cq: string; tag: string; made: { queueId: string; name: string }[]; w: AccountingWords }) {
  const row = view.rows.find((r) => String(r.familyId) === familyId.toLowerCase());
  const drawer = (title: string, body: ReactNode, footer?: ReactNode) => (
    <Drawer param="pick" value={familyId} trigger={false} label={title} alsoClear={["customer", "cq"]} footer={footer} dock>{body}</Drawer>
  );
  if (row === undefined || !row.offers.pick || view.pool === null) {
    return drawer(`Pick a ${w.customerNoun}`, <Notice tone="info" live="none">That family isn&apos;t one a {w.customerNoun} can be picked for here now, so nothing is shown for it.</Notice>);
  }
  const id = String(row.familyId);
  const step: ConfirmStep | null = customerId === null ? null : view.step(id, customerId);
  const found = view.pool.filter((c) => searchMatches(cq, [c.name, c.email]));
  const shown = found.slice(0, CHOOSER_MAX);
  const columns: Column<(typeof shown)[number]>[] = [
    { key: "name", header: capitalized(w.customerNoun), rowHeader: true, cell: (c) => <>{c.name}<span className="when">{c.email ?? "No email address"}</span></> },
    { key: "do", header: "Actions", quiet: true, cell: (c) => <LinkButton variant="tonal" size="sm" href={pickHref(id, c.qboId)}>Look at it<span className="visually-hidden">: {c.name}</span></LinkButton> },
  ];
  const confirm = step !== null && step.ok
    ? <Act say={linkEffect(step.customer.name)}><ConfirmPress familyId={id} about={row.name} offer={step.offer} tag={tag} variant="filled" /></Act> : undefined;
  return drawer(`Pick a ${w.customerNoun} for ${row.name}`, (
    <>
      <LinkAnswersShown />
      {made.map((m) => <Notice key={m.queueId} tone="info" live="none">Making this family in the books was given up after a try the books may have taken, and they have &ldquo;{m.name}&rdquo; from it, with no family linked to it. If it is this family, picking it ties the two together.</Notice>)}
      {step !== null && !step.ok && <Notice tone="warning" live="none">{step.why === "customer" ? `That ${w.customerNoun} isn't one with no family in the portal now, so it can't be linked here. Pick another from the list.` : `That ${w.customerNoun} can't be linked to this family from here now.`}</Notice>}
      {step !== null && step.ok && (
        <div className="stack">
          <h3>Link {step.family} to &ldquo;{step.customer.name}&rdquo;?</h3>
          <p>{chosenWords(w)[step.offer.chosen]} Its email in the books: {step.customer.email ?? "none"}.</p>
          {step.alsoFor.length > 0 && <Notice tone="warning" live="none">This page also suggests this {w.customerNoun} for, or lists it as a possible {w.customerNoun} of, {step.alsoFor.join(", ")}. A {w.customerNoun} can be linked to only one family: link it to the one it really is.</Notice>}
          {step.parents !== null && (step.parents.length === 0 ? <p>The books hold no parent records directly under it.</p>
            : <><p>Parent records the books hold directly under it:</p><ul>{step.parents.map((c) => <li key={c.qboId}>{c.name}{c.active ? "" : " (inactive in the books)"}</li>)}</ul></>)}
          <ProposalsShown proposals={step.offer.proposals} />
        </div>
      )}
      <form method="get" action="/staff/links" role="search">
        <input type="hidden" name="pick" value={id} />
        <Toolbar label={`Search the ${w.customerNounPlural} with no family`} end={<Button type="submit" variant="outlined">Search</Button>}>
          <TextInput id="links-cq" label={`${capitalized(w.customerNoun)} name or email address`} name="cq" type="search" maxLength={SEARCH_MAX} defaultValue={cq} autoComplete="off" />
        </Toolbar>
      </form>
      {view.pool.length === 0 ? <EmptyState title={`Every ${w.customerNoun} the books list as a family is linked to a family in the portal already, so there is none to pick.`} />
        : found.length === 0 ? <Notice tone="info">No {w.customerNoun} with no family matches that.</Notice>
        : <DataTable caption={found.length > shown.length ? `${shown.length} of ${plural(found.length, w.customerNoun, w.customerNounPlural)} with no family that match: search to narrow them` : `${plural(found.length, w.customerNoun, w.customerNounPlural)} with no family`}
            columns={columns} rows={shown} rowKey={(c) => c.qboId} />}
    </>
  ), confirm);
}

/** Which system the books are in, said once on the page with its logo, and when the portal last read them. */
function Connected({ view, w }: { view: LinksView; w: AccountingWords }) {
  const connected = view.state === "listed" || view.state === "no_shape";
  return (
    <div className="links-connected">
      <IntegrationLogo of={w.system} />
      <div><b>{connected ? `Connected to ${w.name}` : w.name}</b>
        <span>{view.readAt ? <>Books read <LocalTime iso={view.readAt} /></> : "Books not read yet"}</span></div>
    </div>
  );
}

/**
 * Accounting links (stage 4's slices M1 to M8 of the app-owned families spec, section 4, "The mapping screen"; its
 * redesign the owner approved on 2026-11-27): every active family, one compact row each, with its match in the books
 * (the record's name and a label whose words say how it matched), Show details (the two records side by side, loaded
 * for that one family and audited), and at most one main press that fits its status (Confirm link, Pick a customer,
 * Confirm this link, Settle N differences). Every other action of a family is in its Review drawer (`?review=`), and a
 * pick in its own drawer (`?pick=`). Nothing here is sent to the books but the Send presses and a student's move taken
 * from the books, each saying so; every press is audited in its own transaction (src/lib/accounting/link-writes.ts,
 * guardian-links.ts, import-writes.ts). The Suggested rows ticked are linked in one press. The customers no family is
 * linked to have their own part here, with "Create a family" and the reviewed import (`?import=1`). For holders of the
 * linking permission (Accounting.Link.ReadWrite, not Admin-only), who also need Roster.Read, checked here and refused as
 * the guard refuses (requireStaffAlso()). The page lists many families, so neither it nor a drawer is audited as a read
 * of one family; Show details is, as it shows one family's contact details. The provider's name and nouns come from the
 * accounting words (src/lib/accounting/words.ts). A server component: the books' text is rendered as text, and the
 * presses are bound actions in small client components given only their words.
 */
export default async function AccountingLinksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Accounting.Link.ReadWrite");
  await requireStaffAlso(ctx, "Roster.Read");
  // Send the portal's value (slice M5a) needs the permission that changes families too: the offers are worked out for
  // every reader, and its press is drawn only for one who holds it.
  const maySend = can(ctx.effective, "Roster.Family.ReadWrite");
  const w = accountingWords();
  const sp = await searchParams;
  const filter = parseLinksFilter(sp);
  // Read before the roster: a press made on this page is refused when the roster was read from another company since.
  const tag = await currentRosterTag();
  // Give up, beside a change kept in the portal (slice M5c), needs the permission that changes families, as giveUpAction() checks.
  const view = await loadAccountingLinks({ mayChange: maySend });
  const counts = statusCounts(view.rows);
  // A carried-over family with differences is found under two filters (filtersOf()), so the counts overlap by this many.
  const overlap = view.rows.filter((r) => filtersOf(r).length > 1).length;
  const rows = filterLinkRows(view.rows, filter);
  // Send the portal's values for all (slice M5b), over the sends this filter shows, by the press's own rule (sendAllShown()), for a reader who may change families.
  const sendAll = maySend ? view.sendAll(filter) : null;
  const filtered = filter.status !== null || filter.q !== "";
  const pick = typeof sp.pick === "string" && sp.pick.length <= 64 ? sp.pick : null;
  const customer = typeof sp.customer === "string" && sp.customer.length <= 64 ? sp.customer : null;
  const cq = typeof sp.cq === "string" && sp.cq.trim().length <= SEARCH_MAX ? sp.cq.trim() : "";
  // A create of the picking family given up after a try the books may have taken, whose customer stands with no family linked to it.
  const pickRow = pick === null ? undefined : view.rows.find((r) => String(r.familyId) === pick.toLowerCase() && r.offers.pick);
  const made = pickRow === undefined ? [] : await givenUpCustomersOf(pickRow.familyId, view);
  // The reviewed import (slice M6): offered while the part for the customers no family is linked to lists one this page
  // aims at no family; its review step is this page at `?import=1`, which writes nothing and reads only the persons who
  // hold its addresses (view.importReview(), one query), for a reader who may change families too.
  const proposable = view.state !== "listed" ? 0 : (view.noFamilyList ?? []).filter((c) => !view.aims.has(c.qboId)).length;
  const importAsked = sp.import === "1";
  const columns: Column<LinkRow>[] = [
    { key: "family", header: "Family", rowHeader: true, sorted: "ascending", cell: (r) => (view.familyPages ? <Link href={familyPage(r.familyId)}>{r.name}</Link> : r.name) },
    { key: "match", header: "Match in your books", cell: (r) => <Match row={r} /> },
    { key: "do", header: "Actions", quiet: true, cell: (r) => (
      <span className="links-acts-cell">
        <DetailsToggle familyId={String(r.familyId)} family={r.name} />
        <MainAction row={r} tag={tag} w={w} />
        {hasReview(r) && <ReviewDrawer row={r} tag={tag} maySend={maySend} w={w} />}
      </span>
    ) },
  ];
  return (
    <main className="wrap single">
      <LinkAnswers><BulkResults>
        <PageHeader title="Accounting links" lede={`Link each family to its ${w.customerNoun} in your books. Linking sends nothing to the books.`}
          actions={<Connected view={view} w={w} />} />
        <LinkAnswersShown />

        {view.state !== "listed" && <Notice tone="warning" live="none">{whyNotChecked(w)[view.state]}</Notice>}

        {pick !== null && <PickDrawer view={view} familyId={pick} customerId={customer} cq={cq} tag={tag} made={made} w={w} />}

        <Card title="Families" titleId="links-list-h"
          description={`Confirm link lets a family's guardians see that ${w.customerNoun}'s invoices, so check it's the right household.`}>
          <form method="get" action="/staff/links" role="search">
            <Toolbar label="Filter the families">
              <Select id="links-status" label="Status" name="status" defaultValue={filter.status ?? ""}>
                <option value="">Every status ({view.rows.length})</option>
                {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS_WORDS[k]} ({counts[k]})</option>)}
              </Select>
              <TextInput id="links-q" label="Family name or email address" name="q" type="search" maxLength={SEARCH_MAX} defaultValue={filter.q} autoComplete="off" />
              <Button type="submit" variant="outlined">Show</Button>
              {filtered && <LinkButton variant="text" href="/staff/links">Show every family</LinkButton>}
            </Toolbar>
          </form>
          {overlap > 0 && <p className="hint">{overlap === 1 ? "1 family whose link was carried over has differences, so it is counted under both Carried over and Linked, with differences."
            : `${overlap} families whose links were carried over have differences, so each is counted under both Carried over and Linked, with differences.`}</p>}
          {sendAll !== null && <SendAllPress offer={sendAll} filter={filter} tag={tag} />}
          {filter.tooLong && <Notice tone="warning" live="none">That search was too long, so nothing was searched for. Try a shorter part of a name or an address, up to {SEARCH_MAX} characters.</Notice>}
          {view.rows.length === 0 ? <EmptyState title="The portal has no active families yet." />
            : rows.length === 0 ? <Notice tone="info">No family matches that.</Notice>
            : <LinkDetailsProvider load={linkDetailsAction}><FamiliesTable rows={rows} columns={columns} tag={tag} w={w}
                caption={filtered ? `${plural(rows.length, "family", "families")} of ${view.rows.length} shown` : `Every family, by name: ${plural(rows.length, "family", "families")}`} /></LinkDetailsProvider>}
        </Card>

        <CustomersWithNoFamily view={view} mayChangeFamilies={maySend} words={w}>
          <ImportOffer proposable={proposable} mayChangeFamilies={maySend} />
        </CustomersWithNoFamily>

        {importAsked && <ImportReview review={maySend && proposable > 0 ? await view.importReview() : null} mayChangeFamilies={maySend} tag={tag} />}

        {view.inactive.length > 0 && <InactivePart rows={view.inactive} tag={tag} familyPages={view.familyPages} maySend={maySend} />}
      </BulkResults></LinkAnswers>
    </main>
  );
}
