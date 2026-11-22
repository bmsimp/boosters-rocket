import Link from "next/link";
import { requireStaffAlso, requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { BULK_MAX, filterLinkRows, filtersOf, givenUpCustomersOf, loadAccountingLinks, REVIEW_LEFT_WORDS, SEND_ALL_MAX, statusCounts, type BulkOffer, type ConfirmStep, type GuardianSendOffer, type GuardianShown, type InactiveRow, type KeptOffer, KEPT_ASK, KEPT_GONE, KEPT_GONE_ASK, type LinkMade, type LinkOffer, type LinkRow, type LinkStatus, type LinksState, type LinksView, type OwnLink, type ReviewOffer, type SendAllOffer, type SendOffer, type TakeOffer, type UnlinkOffer } from "@/lib/accounting/mapping";
import { differenceKinds, differenceWords, guardianDifferenceNext, noteSentence, type Difference } from "@/lib/accounting/differences";
import { NOT_A_FAMILY_WORDS, parseLinksFilter, searchMatches, SEARCH_MAX, STATUS_KEYS, STATUS_WORDS, type LinksFilter, type StatusKey } from "@/lib/accounting/status";
import type { Holder } from "@/lib/accounting/match";
import type { Proposals } from "@/lib/accounting/proposals";
import { recordNameWords } from "@/lib/families/words";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { Button, Card, DataTable, EmptyState, HowThisWorks, LinkButton, LocalTime, Notice, PageHeader, Select, StatusBadge, TextInput, Toolbar, type Column, type Tone } from "@/app/components/ui";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { confirmAllAction, confirmLinkAction, leaveUnlinkedAction, linkGuardianAction, reviewLinkAction, sendAllAction, sendDifferenceAction, takeDifferenceAction, undoLeaveUnlinkedAction, unlinkAction, unlinkGuardianAction } from "./actions";
import { GuardianLinkPress, LinkAnswers, LinkAnswersShown, LinkGiveUp, LinkPress } from "./link-press";
import { giveUpAction } from "../roster/write-actions";
import { CustomersWithNoFamily } from "./no-family";
import { ImportOffer, ImportReview } from "./import-review";

export const metadata = { title: "Accounting links" };
export const dynamic = "force-dynamic";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be suggested now, in words. Differences aren't checked in any of these states either. */
const WHY_NOT_CHECKED: Record<Exclude<LinksState, "listed">, string> = {
  no_company: "The portal hasn't read the books yet, so links, suggestions and differences can't be checked. Each family shows as not checked.",
  other_company: "QuickBooks is connected to a different company from the roster's, so links, suggestions and differences can't be checked. Each family shows as not checked. An Admin can see why under Settings, QuickBooks.",
  no_shape: "The membership shape isn't chosen, or names a customer type the books no longer have, so the portal can't tell which customers are families. Links show as they are, but nothing is suggested or checked. An Admin can choose the shape under Settings, QuickBooks.",
};

/** The tone a status badge carries with its words: a link that stands, something to look at, or nothing checked or wanted. */
const TONE: Record<StatusKey, Tone> = {
  carried_over: "done", linked: "done", with_differences: "due", suggested: "due", several: "due", no_match: "due", left_unlinked: "neutral", not_a_family: "due", customer_gone: "due", not_checked: "neutral",
};

/** At most this many customers are listed at once in the chooser; a search narrows them. */
const CHOOSER_MAX = 50;
/** Where the chooser and the confirm step are drawn, and the list. */
const PICK = "links-pick-h";

const holderWords = (h: Holder) => (h.on.kind === "family" ? `${h.address}, on this customer` : `${h.address}, on ${h.on.name} under it`);

/** How a link was made, in words: carried over from the roster, or by whose press. */
function MadeDetail({ made }: { made: LinkMade }) {
  return made.key === "carried_over" ? <>Carried over from the roster by the portal, on <LocalTime iso={made.at} />. Nobody has confirmed it since.</>
    : made.origin === "confirmed" ? <>Confirmed{made.by ? ` by ${made.by}` : ""}, on this page or with &ldquo;Create a family from this&rdquo;, on <LocalTime iso={made.at} />.</>
    : <>Made in the books from the portal{made.by ? ` by ${made.by}` : ""}, on <LocalTime iso={made.at} />.</>;
}

/** What a status means for the row, in words. Every name and address is the books' text or a person's, shown as text. */
function StatusDetail({ status, row }: { status: LinkStatus; row: LinkRow }) {
  switch (status.key) {
    case "carried_over": case "linked": return <MadeDetail made={status} />;
    // Both things: how the link was made, and how many differences of what kinds (listed in the row's opening).
    case "with_differences": return <><MadeDetail made={status.made} /> {plural(row.differences.length, "difference", "differences")} with the books: {differenceKinds(row.differences).join(", ")}.</>;
    case "customer_gone": return <>The customer this family is linked to isn&apos;t in the books&apos; copy any more. The link is kept as it is.</>;
    case "not_a_family": return <>The linked customer is still in the books, but isn&apos;t a family there now: {status.reasons.map((r) => NOT_A_FAMILY_WORDS[r]).join("; ")}. The link is kept as it is.</>;
    case "suggested": return <>A guardian&apos;s sign-in address matches: {status.holders.map(holderWords).join("; ")}.</>;
    case "several": return status.why === "many"
      ? <>More than one customer with no family holds a guardian&apos;s sign-in address, so none is filled in.</>
      : <>The one customer that holds a guardian&apos;s sign-in address also holds an address of {status.alsoMatches.length === 1 ? "another family's guardian" : "other families' guardians"}, so it isn&apos;t filled in for any of them.</>;
    case "no_match": return status.noGuardians
      ? <>This family has no guardians yet, so there is no address to match.</>
      : row.addresses.length === 0 ? <>None of this family&apos;s guardians can sign in, so there is no address to match.</>
      : <>No customer with no family holds any of its guardians&apos; sign-in addresses.</>;
    case "left_unlinked": return <>Left unlinked{status.by ? ` by ${status.by}` : ""}, on <LocalTime iso={status.at} />. No customer is suggested for it until someone undoes this or links it.</>;
    case "not_checked": return <>The books can&apos;t be checked now, so nothing is suggested.</>;
  }
}

/** How a link was made, in a few words, for the status cell's line: the day, and who or what made it. */
function MadeMeta({ made }: { made: LinkMade }) {
  return made.key === "carried_over" ? <>Carried over <LocalTime iso={made.at} dateOnly /> · not confirmed</>
    : made.origin === "confirmed" ? <>Confirmed <LocalTime iso={made.at} dateOnly /></>
    : <>Made in the books <LocalTime iso={made.at} dateOnly /></>;
}

/**
 * The status cell's one short line under its badge. The whole sentence (StatusDetail), and the differences, are in the
 * row's Details.
 */
function StatusMeta({ status, row }: { status: LinkStatus; row: LinkRow }) {
  switch (status.key) {
    case "carried_over": case "linked": return <MadeMeta made={status} />;
    case "with_differences": return <><MadeMeta made={status.made} /> · {plural(row.differences.length, "difference", "differences")}</>;
    case "customer_gone": return <>Customer not in the books&apos; copy</>;
    case "not_a_family": return <>Customer isn&apos;t a family there now</>;
    case "suggested": return <>A guardian&apos;s sign-in address matches</>;
    case "several": return status.why === "many" ? <>More than one customer matches</> : <>Its customer matches other families too</>;
    case "no_match": return status.noGuardians ? <>No guardians yet</> : row.addresses.length === 0 ? <>No guardian can sign in</> : <>No customer holds their addresses</>;
    case "left_unlinked": return <>{status.by ? `By ${status.by}, ` : ""}<LocalTime iso={status.at} dateOnly /></>;
    case "not_checked": return <>The books can&apos;t be checked now</>;
  }
}

/** A student's or guardian's own link, in words. */
const ownLinkWords = (l: OwnLink) => (l.state === "linked" ? `linked to ${l.customer}` : l.state === "gone" ? "linked to a customer that isn't in the books' copy any more"
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
    case "own": return ", their own Parent customer under this family";
    // Only a Parent customer directly under this family's customer is `shared` (guardianLinkOf()): one guardian of this family left on it alone is theirs.
    case "shared": return g.sharedWith.length === 0 ? ", which another guardian of this family is linked to as well, so it is nobody's own and nothing is sent for them: unlink every guardian from it but one of this family's to make it that guardian's own"
      : `, which a guardian of ${listed(g.sharedWith)} is linked to as well, so it is nobody's own and nothing is sent for them: unlink every guardian from it but one of this family's to make it that guardian's own`;
    case "elsewhere": return ", which isn't a Parent customer directly under this family's customer in the books, so nothing is sent for them";
    case "gone": return ", so nothing is sent for them";
  }
}

/** What Link this guardian does, said beside every one (linkGuardian(), src/lib/accounting/guardian-links.ts). */
const GUARDIAN_LINK_EFFECT = "Linking sends nothing to the books and doesn't change their access. From then on, while it's theirs alone, their rename, removal and changes of phone, mailing address or sign-in email go to that Parent customer. What the portal holds now isn't sent.";
/**
 * What Unlink this guardian does, as a warning beside every one (unlinkGuardian()): a change of their details refuses
 * it nothing (a waiting one is given up at its next try, a stuck or kept one stays on Reconciliation), and linking them
 * again is offered here only where the family may have a guardian linked (`relink`). The press is drawn only while
 * nothing on the queue holds it back (`unlinkHeld`), so the warning needn't say what does.
 */
const GUARDIAN_UNLINK_EFFECT = (who: string, relink: boolean) => `Unlinking ends only ${who}'s own link. Nothing is sent to the books, and their access doesn't change. A waiting change of their details is dropped unsent. One that's stuck or kept stays on Reconciliation to give up. Nothing more is sent for them, and no Parent customer is made for them. ${relink ? "They can be linked again here." : "Linking them again isn't offered here until this family is linked to a family customer that stands in the books and the membership shape has a parent type."}`;

/** Reconciliation's list of changes, where a change the queue holds is shown with what can be done about it. */
const RECONCILIATION_CHANGES = "/staff/reconciliation#writes-h";
const isAre = (n: number) => (n === 1 ? "is" : "are");
/** What on the write queue holds Link this guardian back (GuardianShown.linkHeld), in words; null for nothing. */
function linkHeldWords(g: GuardianShown): string | null {
  const h = g.linkHeld;
  if (h === null) return null;
  if (h.row > 0) return `${h.row === 1 ? "A change" : `${h.row} changes`} for ${g.name} ${isAre(h.row)} waiting, stuck or kept on the Reconciliation page, so linking them isn't offered until ${h.row === 1 ? "it has" : "they have"} gone through or been given up there.`;
  return `${h.customers === 1 ? "A Parent customer" : `${h.customers} Parent customers`} under this family that no guardian is linked to ${h.customers === 1 ? "has" : "have"} a change waiting, stuck or kept on the Reconciliation page, so ${h.customers === 1 ? "it isn't" : "they aren't"} offered until it has gone through or been given up there.`;
}
/** What on the write queue holds Unlink this guardian back (GuardianShown.unlinkHeld), in words. */
const unlinkHeldWords = (g: GuardianShown) => `${g.unlinkHeld === 1 ? "A change" : `${g.unlinkHeld} changes`} of ${g.name}'s Parent customer, or of the customer they are linked to, ${isAre(g.unlinkHeld)} waiting, stuck or kept on the Reconciliation page, so unlinking them isn't offered until ${g.unlinkHeld === 1 ? "it has" : "they have"} gone through or been given up there.`;

/** One open guardian of the row's opening (since slice M3c with its link's standing, Link this guardian or Unlink this guardian). */
function GuardianLine({ g, row, tag }: { g: GuardianShown; row: LinkRow; tag: string }) {
  return (
    <li>{g.name} ({g.email}){g.blocked ? ", can't sign in, so this address isn't matched" : ""}: {ownLinkWords(g.link)}{standingWords(g)}
      {g.offer !== null && (
        <>
          <p>{g.offer.suggested !== null ? `A Parent customer under this family in the books that no guardian is linked to is named like ${g.name} or holds their sign-in address, and is filled in. Any of them can be chosen instead.`
            : `These are the Parent customers under this family in the books that no guardian is linked to. None is filled in: choose the one that is ${g.name}'s.`}</p>
          <GuardianLinkPress name={`guardian-${g.id}`} who={g.name} about={row.name} suggested={g.offer.suggested}
            options={g.offer.candidates.map((c) => ({ value: c.qboId, label: c.name, hint: c.email ?? "No email address",
              act: linkGuardianAction.bind(null, g.id, c.qboId, c.qboId === g.offer!.suggested ? "suggested" : "picked", tag, g.offer!.stamps[c.qboId]!) }))} />
          <p>{GUARDIAN_LINK_EFFECT}</p>
        </>
      )}
      {linkHeldWords(g) !== null && <p>{linkHeldWords(g)} <Link href={RECONCILIATION_CHANGES}>See the changes on Reconciliation<span className="visually-hidden">: {g.name}</span></Link></p>}
      {g.unlinkHeld > 0 && <p>{unlinkHeldWords(g)} <Link href={RECONCILIATION_CHANGES}>See the changes on Reconciliation<span className="visually-hidden">: {g.name}</span></Link></p>}
      {g.noOffer !== null && <p>{g.noOffer.why === "elsewhere" ? `Their own record in the books is under ${g.noOffer.family}, and the portal links it there, so none is offered here.`
        : "There is no active Parent customer under this family in the books that no guardian is linked to, so none can be linked to them here."}</p>}
      {g.unlink !== null && (
        <>
          <Notice tone="warning" live="none">{GUARDIAN_UNLINK_EFFECT(g.name, g.relink)}</Notice>
          <div className="row-actions"><LinkPress label={`Unlink ${g.name} from this Parent customer`} busy="Unlinking…" about={row.name} act={unlinkGuardianAction.bind(null, g.id, g.unlink.linkId, tag, g.unlink.stamp)} /></div>
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
        {take !== undefined && <LinkPress label="Take QuickBooks' into the app" busy="Taking it…" about={take.about} act={takeDifferenceAction.bind(null, take.field, take.kind, take.recordId, tag, take.stamp)} />}
        {send !== undefined && <SendPress send={send} tag={tag} />}
        {kept !== undefined && kept.giveUp && <GiveUpPress kept={kept} about={send?.about ?? take?.about ?? w.what} />}</div>}</li>
  );
}

/**
 * Give up, for a change kept in the portal (slice M5c): the same press as Reconciliation's (giveUpAction(), today's
 * giveUp(), its permission and its audit row), with the same words, given only its words (and whom it is about, read
 * out) and the bound action. Its answer is kept above the list with every other press's (LinkGiveUp), as the kept
 * change, and this press with it, leaves the row once it is given up.
 */
function GiveUpPress({ kept, about }: { kept: KeptOffer; about: string }) {
  return (
    <details className="more"><summary>Give up</summary>
      <p className="hint">The portal keeps its own value, and QuickBooks keeps what it has.</p>
      <LinkGiveUp about={about} act={giveUpAction.bind(null, kept.itemId)} />
    </details>
  );
}

/**
 * A change kept in the portal that the roster's copy of QuickBooks has already (slice M5c, `at` null): its words, why
 * nothing is sent, and Give up; for a reader who may not give it up, who does, and where.
 */
function KeptGoneLine({ kept, about }: { kept: KeptOffer; about: string }) {
  return <li>{kept.words} {kept.giveUp ? KEPT_GONE : KEPT_GONE_ASK}{kept.giveUp && <div className="row-actions"><GiveUpPress kept={kept} about={about} /></div>}</li>;
}

/**
 * Send the app's to QuickBooks (slice M5a): the press, a bound action given only its words. It reads QuickBooks first
 * (a make-inactive's balance, or a change's answer) and sends, so its busy words say both, as Reconciliation's do.
 */
function SendPress({ send, tag }: { send: SendOffer | GuardianSendOffer; tag: string }) {
  return <LinkPress label="Send the app's to QuickBooks" busy="Reading QuickBooks, then sending…" about={send.about} act={sendDifferenceAction.bind(null, send.field, send.kind, send.recordId, tag, send.stamp)} />;
}

/**
 * The inactive families the books have active (slice M4b), after the list: each family by name (a link to its page while
 * those stand), its customer in the books (the books' text, as text), its inactive students by name, and Take
 * QuickBooks' into the app with what it does said beside it, or the one sentence that stands in its place. Drawn only
 * when there is one. The press is a bound action, given only its words. Since slice M5c the family's own make-inactive
 * kept in the portal (`kept`) is said first, with its Give up beside the Take and the Send.
 */
function InactivePart({ rows, tag, familyPages, maySend }: { rows: InactiveRow[]; tag: string; familyPages: boolean; maySend: boolean }) {
  const columns: Column<InactiveRow>[] = [
    { key: "family", header: "Family", rowHeader: true, cell: (r) => (familyPages ? <Link href={familyPage(r.familyId)}>{r.name}</Link> : r.name) },
    { key: "customer", header: "Customer in the books", cell: (r) => r.customer },
    { key: "students", header: "Its students, inactive in the portal", cell: (r) => (r.students.length === 0 ? "None" : r.students.join(", ")) },
    { key: "do", header: "What you can do", quiet: true, cell: (r) => {
      const send = maySend ? r.send : null;
      const kept = r.kept;
      return <>{kept !== null && <p>{kept.giveUp ? kept.words : `${kept.words} ${KEPT_ASK}`}</p>}{r.take === null && <p>{r.note}</p>}{r.take !== null && <p>{r.take.words.join(" ")}</p>}
        {send !== null ? <p>{send.words.join(" ")}</p> : maySend && r.sendNote !== null && <p>{r.sendNote}</p>}
        {(r.take !== null || send !== null || kept?.giveUp === true) && <div className="row-actions">
          {r.take !== null && <LinkPress label="Take QuickBooks' into the app" busy="Taking it…" about={r.take.about}
            act={takeDifferenceAction.bind(null, r.take.field, r.take.kind, r.take.recordId, tag, r.take.stamp)} />}
          {send !== null && <SendPress send={send} tag={tag} />}
          {kept !== null && kept.giveUp && <GiveUpPress kept={kept} about={`${r.name}'s active status`} />}</div>}</>;
    } },
  ];
  return (
    <Card title="Inactive in the portal, active in the books" titleId="links-inactive-h">
      <p>Inactive here, active in the books. Taking the books&apos; value makes the family active again here, on its own, and sends nothing.
        Its guardians can&apos;t sign in until someone who may change families lets them in on its page.
        {maySend && " Sending the app's value makes it inactive in the books instead, with everyone under it, and changes nothing here."}</p>
      <DataTable caption={plural(rows.length, "inactive family the books have active", "inactive families the books have active")} captionHidden columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} />
    </Card>
  );
}

/**
 * What a link press would link with the family, and what it would leave on each side, in words: every pair as "<the
 * record's name> with <the customer's name>", the records and customers left, and that those left aren't linked by it.
 * Since slice M3c2 the guardians it would link, each "<the person's name> with <the Parent customer's name>", and those
 * the write queue holds back, each with what holds it and how it is linked once that has cleared (proposalsFor()). The
 * Parent customers no guardian is paired with aren't listed: once the family is linked they show among its differences.
 */
function ProposalsShown({ proposals }: { proposals: Proposals }) {
  const { guardians, guardiansHeld } = proposals;
  return (
    <>
      <StudentProposalsShown proposals={proposals} />
      {guardians.length > 0 && <><p>Guardians linked with it, by the sign-in address their Parent customer&apos;s email field holds:</p>
        <ul>{guardians.map((g) => <li key={g.guardianId}>{g.who} with {g.customerName}</li>)}</ul></>}
      {guardiansHeld.length > 0 && <><p>Not linked with it, though their Parent customer&apos;s email field holds their sign-in address:</p>
        <ul>{guardiansHeld.map((g) => <li key={g.guardianId}>{g.who} with {g.customerName}: a change for them or for their Parent customer is waiting, stuck or kept on the Reconciliation page, so they aren&apos;t linked with it.
          Once it has gone through or been given up there, they can be linked in the opening of the family&apos;s row on this page, with Link this guardian, if the family is linked by then and that Parent customer is still free for them.
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
      {customersLeft.length > 0 && <><p>Left with no record in the portal, of the student customers under it in the books:</p><ul>{customersLeft.map((c) => <li key={c.qboId}>{c.name}{c.active ? "" : " (inactive in the books)"}</li>)}</ul></>}
      {(recordsLeft.length > 0 || customersLeft.length > 0) && <p>{customersLeft.some((c) => !c.active)
        ? "Students left aren't linked by this press. Once the family is linked, they show with its row among its differences, but for a student customer inactive in the books, which is only counted there."
        : "Students left aren't linked by this press. Once the family is linked, they show with its row among its differences."}</p>}
    </>
  );
}

/** What a link does on the parents' side, and how it is taken back: said beside every Confirm. */
const LINK_EFFECT = "Once linked, the family's guardians see this customer's open invoices and Pay links (and those of students and parents directly under it) next time they open Home or Payments, and a pay-instead choice bills it. Unlink from the books undoes it, but they may have seen the invoices by then, so check it's the right household.";
/**
 * What a guardian linked with a family's Confirm has from then on (slice M3c2), said beside every Confirm only where the
 * books have a parent type (LinksView.guardianLinks): the same as Link this guardian's (GUARDIAN_LINK_EFFECT), so the two
 * are kept true together.
 */
const LINK_GUARDIANS_EFFECT = "From then on, a guardian linked with it has their rename, removal and changes of phone, mailing address or sign-in email sent to that Parent customer, while it's theirs alone. Linking sends nothing, and what the portal holds now isn't sent.";

/** The address of the chooser for a family, or of its confirm step for a customer. */
const pickHref = (familyId: string, customerId?: string) => `/staff/links?pick=${encodeURIComponent(familyId)}${customerId ? `&customer=${encodeURIComponent(customerId)}` : ""}#${PICK}`;

/** The row's opening: the family's active students and its open guardians, each with their own link, then its differences, then what can be done. */
function Opening({ row, tag, guardianLinks, maySend }: { row: LinkRow; tag: string; guardianLinks: boolean; maySend: boolean }) {
  const id = String(row.familyId);
  return (
    <details className="more"><summary>Details<span className="visually-hidden">: {row.name}</span></summary>
      <p><StatusDetail status={row.status} row={row} /></p>
      <p>{row.students.length === 0 ? "No active students." : "Students:"}</p>
      {row.students.length > 0 && <ul>{row.students.map((s) => <li key={String(s.id)}>{s.name}: {ownLinkWords(s.link)}</li>)}</ul>}
      <p>{row.guardians.length === 0 ? "No guardians." : "Guardians:"}</p>
      {row.guardians.length > 0 && <ul>{row.guardians.map((g) => <GuardianLine key={g.id} g={g} row={row} tag={tag} />)}</ul>}
      {row.removed.length > 0 && <><p>Removed guardians, with their own Parent customers in the books:</p>
        <ul>{row.removed.map((r) => <li key={r.id}>{r.name}: {r.customer === null ? "linked to a customer that isn't in the books' copy any more" : `linked to ${r.customer}, ${r.active ? "active" : "inactive"} in the books`}</li>)}</ul>
        <p>A removed guardian&apos;s Parent customer is theirs again if they are added back under Portal sign-ins, so it isn&apos;t offered to another guardian here, and their link isn&apos;t ended on its own: Unlink from the books ends it with the family&apos;s.</p></>}
      {row.status.key === "several" && <><p>Possible customers:</p><ul>{row.status.candidates.map((c) => <li key={c.qboId}>{c.name}{c.email ? ` (${c.email})` : ""} <Link href={pickHref(id, c.qboId)}>Look at it before linking<span className="visually-hidden">: {c.name}</span></Link></li>)}</ul></>}
      {row.status.key === "several" && row.status.alsoMatches.length > 0 && <p>Also matched by: {row.status.alsoMatches.join(", ")}.</p>}
      {row.differences.length > 0 && <><p>Where the portal and the books differ:</p><ul>{row.differences.map((d, i) => <DifferenceLine key={i} d={d} tag={tag} take={row.takes.find((t) => t.at === i)} note={row.takeNotes.find((n) => n.at === i)?.words}
        send={maySend ? row.sends.find((x) => x.at === i) ?? row.guardianSends.find((x) => x.at === i) : undefined} sendNote={maySend ? row.sendNotes.find((n) => n.at === i)?.words : undefined} kept={row.kept.find((k) => k.at === i)} />)}</ul></>}
      {row.kept.some((k) => k.at === null) && <><p>Changes kept in the portal that the roster&apos;s copy of QuickBooks has already:</p>
        <ul>{row.kept.filter((k) => k.at === null).map((k) => <KeptGoneLine key={k.itemId} kept={k} about={row.name} />)}</ul></>}
      {row.inactiveUnrecorded > 0 && <p>The books also have {plural(row.inactiveUnrecorded, "inactive student customer", "inactive student customers")} under this family with no student record in the portal.</p>}
      {row.confirm !== null && row.customer !== null && <><p>Confirming links it to &ldquo;{row.customer.name}&rdquo;. Nothing is sent to the books.</p><ProposalsShown proposals={row.confirm.proposals} /><p>{LINK_EFFECT}</p>{guardianLinks && <p>{LINK_GUARDIANS_EFFECT}</p>}</>}
      {row.review !== null && <ReviewShown review={row.review} />}
      {row.unlink !== null && <UnlinkShown unlink={row.unlink} />}
      {row.offers.pick && <p className="link-line"><Link href={pickHref(id)}>Pick a different customer<span className="visually-hidden">: {row.name}</span></Link></p>}
      {(row.confirm !== null || row.review !== null || row.unlink !== null || row.offers.leave || row.offers.undo) && (
        <div className="row-actions">
          {row.confirm !== null && <ConfirmPress familyId={id} about={row.name} offer={row.confirm} tag={tag} />}
          {row.review !== null && <LinkPress label="Confirm this link" busy="Confirming…" about={row.name} act={reviewLinkAction.bind(null, id, row.review.linkId, tag, row.review.stamp)} />}
          {row.unlink !== null && <LinkPress label="Unlink from the books" busy="Unlinking…" about={row.name} act={unlinkAction.bind(null, id, row.unlink.linkId, tag, row.unlink.stamp)} />}
          {row.offers.leave && <LinkPress label="Leave unlinked" busy="Leaving it unlinked…" about={row.name} act={leaveUnlinkedAction.bind(null, id, tag)} />}
          {row.offers.undo && <LinkPress label="Undo Left unlinked" busy="Undoing…" about={row.name} act={undoLeaveUnlinkedAction.bind(null, id, tag)} />}
        </div>
      )}
    </details>
  );
}

/**
 * What Confirm this link records, for a carried-over link (slice M3a2): that a staff member checked it, that nothing is
 * sent, and which of the family's carried-over student links it confirms with it and which it leaves, by name.
 */
function ReviewShown({ review }: { review: ReviewOffer }) {
  return (
    <>
      <p>Confirm this link records it as checked by you, so it no longer reads as carried over. Nothing is sent to the books.</p>
      <p>{review.confirms.length === 0 ? "No student's link is confirmed with it." : "Confirmed with it, each carried over to a student customer directly under this customer:"}</p>
      {review.confirms.length > 0 && <ul>{review.confirms.map((c) => <li key={c.linkId}>{c.name}</li>)}</ul>}
      {review.leaves.length > 0 && <><p>Left carried over, as the portal and the books don&apos;t agree on them:</p>
        <ul>{review.leaves.map((l) => <li key={l.linkId}>{l.name} ({REVIEW_LEFT_WORDS[l.why]})</li>)}</ul></>}
    </>
  );
}

/**
 * What Unlink from the books does (slice M3b), each sentence true by the code (unlinkFamily(), src/lib/accounting/link-writes.ts):
 * the links it ends, that nothing is sent, what the guardians then read and that the figures are forgotten, what stays,
 * what holds it back, and how the family is linked again.
 */
function UnlinkShown({ unlink }: { unlink: UnlinkOffer }) {
  const guardians = unlink.guardianLinks === 0 ? "" : unlink.guardianLinks === 1 ? ", and a guardian's own link to a Parent customer" : `, and ${unlink.guardianLinks} guardians' own links to Parent customers`;
  return (
    <>
      <h3>Unlink from the books</h3>
      <p>Unlinking ends this family&apos;s link to {unlink.customer === null ? "its customer, which the books' copy doesn't hold now" : <>&ldquo;{unlink.customer}&rdquo;</>}
        {unlink.students.length === 0 ? ", with no student's link" : `, with the ${unlink.students.length === 1 ? "link of its student" : "links of its students"} ${unlink.students.map((s) => s.name).join(", ")}`}{guardians}.
        {" "}{unlink.customer === null ? "Nothing is sent to the books." : "Nothing is sent to the books, and the customer stays there as it is."}</p>
      <p>Its guardians then see no invoices, Pay or buy-out offer until it&apos;s linked again, and its stored figures are forgotten.
        Everything else (students, guardians, sign-ins, season, volunteering, forms) stays.
        It can&apos;t be unlinked while a buy-out isn&apos;t settled or a change waits on Reconciliation.</p>
      <p>Link it again here, with Confirm or Pick a different customer. While its customer is still in the books, &ldquo;Create in QuickBooks and link&rdquo; isn&apos;t offered, so no second customer is made.</p>
    </>
  );
}

/**
 * Confirm all exact email matches (slice M3a2): for the Suggested rows the filter shows now, in the `listed` state, a
 * press bound to the filter as parsed, the count, the roster tag and the stamp sealing those rows, and nothing else;
 * with more than BULK_MAX, no press but a notice to narrow the list. A Suggested row a press would refuse whatever
 * happened meanwhile (the family's own create waiting or stuck on the queue) isn't counted, and a notice says so.
 */
function BulkPress({ bulk, filter, tag }: { bulk: BulkOffer; filter: LinksFilter; tag: string }) {
  const held = bulk.waiting === 0 ? null : (
    <Notice tone="info" live="none">{bulk.waiting === 1 ? "1 Suggested row isn't" : `${bulk.waiting} Suggested rows aren't`} included: {bulk.waiting === 1 ? "it is" : "each is"} waiting to be made in the books,
      or is linked to another company&apos;s customer. Each row&apos;s Confirm says which.</Notice>
  );
  if (bulk.count === 0) return held;
  if (bulk.stamp === null) {
    return <>{held}<Notice tone="info" live="none">This list shows {bulk.count} Suggested rows. Up to {BULK_MAX} can be confirmed at once, so narrow the list with the search first.</Notice></>;
  }
  return (
    <div className="stack">
      {held}
      <p>Links each of the {plural(bulk.count, "Suggested family", "Suggested families")} shown to the customer on its row, with the students and guardians its row lists.
        If the list changes before you press, nothing is linked and it&apos;s shown again. Nothing is sent to the books.</p>
      <p>Guardians then see their customer&apos;s open invoices and Pay links (and those of students and parents under it) next time they open Home or Payments. Unlink from the books undoes a link, but they may have seen the invoices by then, so look the rows over first.</p>
      <div className="row-actions">
        <LinkPress label={`Confirm all exact email matches (${bulk.count})`} busy="Linking…" about="Confirm all exact email matches"
          act={confirmAllAction.bind(null, filter.status ?? "", filter.q, bulk.count, tag, bulk.stamp)} />
      </div>
    </div>
  );
}

/**
 * Send the app's for all (slice M5b): for the names and students' families the filter shows now, in the `listed` state,
 * for a reader who may change families, a press bound to the filter as parsed, the count, the roster tag and the stamp
 * sealing those sends, and nothing else; with more than SEND_ALL_MAX, no press but a notice to narrow the list. What it
 * passes over (each make-inactive, each difference whose customer the books have inactive) and what it leaves for a
 * later press are said in a notice, with why; since slice M3c4 so is that a guardian's Parent customer is sent from its
 * own row, only where the list shows one.
 */
function SendAllPress({ offer, filter, tag }: { offer: SendAllOffer; filter: LinksFilter; tag: string }) {
  const { inactive, booksInactive } = offer.passedOver;
  const said = [
    inactive > 0 ? `It skips ${plural(inactive, "make-inactive", "make-inactives")}: each reads a balance first, so send ${inactive === 1 ? "it" : "each"} on its row.` : null,
    booksInactive > 0 ? `It passes over ${plural(booksInactive, "difference whose customer QuickBooks has inactive", "differences whose customer QuickBooks has inactive")}: the portal sends nothing there, and never makes a customer active.` : null,
    offer.later > 0 ? `${offer.later === 1 ? "One more difference waits" : `${offer.later} more differences wait`} for a change this press queues to reach QuickBooks first, as ${offer.later === 1 ? "it reads" : "they read"} the same customer: press again once it has.` : null,
    // Slice M3c4: a guardian's send is never part of it, said only where the list shows one.
    offer.guardians > 0 ? "A guardian's Parent customer is sent from its own row." : null,
  ].filter((x): x is string => x !== null);
  const notes = said.length === 0 ? null : (
    <Notice tone="info" live="none">Send the app&apos;s for all sends only names and students&apos; families. {said.join(" ")}{offer.inactiveListed && " The inactive families listed after the families aren't part of it."}</Notice>
  );
  if (offer.count === 0) return notes;
  if (offer.stamp === null) {
    return <>{notes}<Notice tone="info" live="none">This list shows {offer.count} names and students&apos; families to send. Up to {SEND_ALL_MAX} can be sent at once, so narrow the list with the search or a status first.</Notice></>;
  }
  return (
    <div className="stack">
      {notes}
      <p>Queues the portal&apos;s value for each of the {plural(offer.count, "name and student's family", "names and students' families")} shown, as each row&apos;s Send would.
        They go within a few minutes. One QuickBooks changed since this page loaded is kept, not sent over, and shows on Reconciliation.
        If the list changes before you press, nothing is queued.</p>
      <div className="row-actions">
        <LinkPress label={`Send the app's for all (${offer.count})`} busy="Queueing…" about="Send the app's for all"
          act={sendAllAction.bind(null, filter.status ?? "", filter.q, offer.count, tag, offer.stamp)} />
      </div>
    </div>
  );
}

function ConfirmPress({ familyId, about, offer, tag }: { familyId: string; about: string; offer: LinkOffer; tag: string }) {
  return <LinkPress label="Confirm" busy="Linking…" about={about} act={confirmLinkAction.bind(null, familyId, offer.customerId, offer.chosen, tag, offer.stamp)} />;
}

/** How the customer on the confirm step was chosen, in words. */
const CHOSEN_WORDS = { suggested: "It is this family's suggestion.", several: "It is one of the customers that hold a guardian's sign-in address.", picked: "You picked it from the customers no family is linked to." } as const;

/**
 * Pick a different customer, and the confirm step, for one family: the customers no family is linked to (the pool, by
 * name with its email field, searchable), and for the one chosen, what the press would link and leave. Reached from the
 * list by the page's address, which is parsed here and never trusted: a family the list doesn't offer a pick for, or a
 * customer not in the pool, is told in a plain notice. It shows nothing the list doesn't, so it isn't audited.
 */
function PickPart({ view, familyId, customerId, cq, tag, made }: { view: LinksView; familyId: string; customerId: string | null; cq: string; tag: string; made: { queueId: string; name: string }[] }) {
  const row = view.rows.find((r) => String(r.familyId) === familyId.toLowerCase());
  if (row === undefined || !row.offers.pick || view.pool === null) {
    return <Notice tone="info" live="none">That family isn&apos;t one a customer can be picked for here now, so nothing is shown for it. <Link href="/staff/links">Show every family</Link></Notice>;
  }
  const id = String(row.familyId);
  const step: ConfirmStep | null = customerId === null ? null : view.step(id, customerId);
  const found = view.pool.filter((c) => searchMatches(cq, [c.name, c.email]));
  const shown = found.slice(0, CHOOSER_MAX);
  const columns: Column<(typeof shown)[number]>[] = [
    { key: "name", header: "Customer", rowHeader: true, cell: (c) => <>{c.name}<span className="when">{c.email ?? "No email address"}</span></> },
    { key: "do", header: "What you can do", quiet: true, cell: (c) => <Link className="link-line" href={pickHref(id, c.qboId)}>Look at it<span className="visually-hidden">: {c.name}</span></Link> },
  ];
  return (
    <Card title={<>A customer for {row.name}</>} titleId={PICK}>
      {made.map((m) => <Notice key={m.queueId} tone="info" live="none">Making this family in the books was given up after a try the books may have taken, and they have the customer &ldquo;{m.name}&rdquo; from it, with no family linked to it. If it is this family, picking it ties the two together.</Notice>)}
      {step !== null && !step.ok && <Notice tone="warning" live="none">{step.why === "customer" ? "That customer isn't one with no family in the portal now, so it can't be linked here. Pick another from the list." : "That customer can't be linked to this family from here now."}</Notice>}
      {step !== null && step.ok && (
        <div className="stack">
          <h3>Link {step.family} to &ldquo;{step.customer.name}&rdquo;?</h3>
          <p>{CHOSEN_WORDS[step.offer.chosen]} Its email field in the books: {step.customer.email ?? "none"}.</p>
          {step.alsoFor.length > 0 && <Notice tone="warning" live="none">This page also suggests this customer for, or lists it as a possible customer of, {step.alsoFor.join(", ")}. A customer can be linked to only one family: link it to the one it really is.</Notice>}
          {step.parents !== null && (step.parents.length === 0 ? <p>The books hold no Parent customers directly under it.</p>
            : <><p>Parent customers the books hold directly under it:</p><ul>{step.parents.map((c) => <li key={c.qboId}>{c.name}{c.active ? "" : " (inactive in the books)"}</li>)}</ul></>)}
          <ProposalsShown proposals={step.offer.proposals} />
          <p>Nothing is sent to the books.</p>
          <p>{LINK_EFFECT}</p>
          {view.guardianLinks && <p>{LINK_GUARDIANS_EFFECT}</p>}
          <div className="row-actions"><ConfirmPress familyId={id} about={row.name} offer={step.offer} tag={tag} /></div>
        </div>
      )}
      <form method="get" action="/staff/links" role="search">
        <input type="hidden" name="pick" value={id} />
        <Toolbar label="Search the customers with no family"
          end={<><Button type="submit" variant="secondary">Search</Button><LinkButton variant="quiet" href="/staff/links">Close</LinkButton></>}>
          <TextInput id="links-cq" label="Customer name or email address" name="cq" type="search" maxLength={SEARCH_MAX} defaultValue={cq} autoComplete="off" />
        </Toolbar>
      </form>
      {view.pool.length === 0 ? <EmptyState title="Every customer the books list as a family is linked to a family in the portal already, so there is none to pick." />
        : found.length === 0 ? <Notice tone="info">No customer with no family matches that.</Notice>
        : <DataTable caption={found.length > shown.length ? `${shown.length} of ${plural(found.length, "customer", "customers")} with no family that match: search to narrow them` : `${plural(found.length, "customer", "customers")} with no family`}
            columns={columns} rows={shown} rowKey={(c) => c.qboId} />}
    </Card>
  );
}

/**
 * Accounting links (stage 4's slices M1 to M3a of the app-owned families spec, section 4, "The mapping screen"): every
 * active family, its link to its customer in the books and how that link stands, or the customer that looks like its
 * own, with a status on each row, a filter by status and a search. Since slice M3a a family with no link is linked here
 * (Confirm its suggestion or a candidate, or Pick a different customer), or left unlinked, and nothing is sent to the
 * books; each press is audited, in its own transaction (src/lib/accounting/link-writes.ts). Since slice M3a2 the
 * Suggested rows the filter shows are confirmed in one press (Confirm all exact email matches), and a carried-over link
 * is confirmed as reviewed in its row (Confirm this link). Since slice M3b a linked family is unlinked in its row (Unlink
 * from the books), and linked again with the presses above. Since slice M3c a guardian of a linked family is linked to
 * a Parent customer under it in the row's opening (Link this guardian), and one guardian's link ended alone (Unlink
 * this guardian, which splits a shared one), src/lib/accounting/guardian-links.ts; the removed guardians' Parent
 * customers are shown, never pressed. Since slice M6 the customers no family is linked to have their own part here
 * (conformance L.15), each with "Create a family from this", and the reviewed import proposes families from the books
 * for them (Propose families from the books, its review at `?import=1`, src/lib/accounting/import-writes.ts). For holders of the linking
 * permission (Accounting.Link.ReadWrite, not Admin-only), who also need Roster.Read, checked here and refused as the
 * guard refuses (requireStaffAlso()): a role written with patterns can hold the first without the second. The page
 * lists many families, so neither the page, a row's opening, the chooser nor the confirm step is audited as a read of
 * one family, as Reconciliation isn't; each family's own page is. A server component: the books' text (names, email
 * fields) is rendered as text, and the presses are bound actions in a small client component given only their words.
 */
export default async function AccountingLinksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Accounting.Link.ReadWrite");
  await requireStaffAlso(ctx, "Roster.Read");
  // Send the app's to QuickBooks (slice M5a) needs the permission that changes families too: the offers are worked out for
  // every reader, and its press is drawn only for one who holds it.
  const maySend = can(ctx.effective, "Roster.Family.ReadWrite");
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
  // Confirm all exact email matches, over the Suggested rows this filter shows, by the press's own rule (suggestedRowsShown()).
  const bulk = view.bulk(filter);
  // Send the app's for all (slice M5b), over the sends this filter shows, by the press's own rule (sendAllShown()), for a reader who may change families.
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
    { key: "addresses", header: "Sign-in addresses", cell: (r) => (r.addresses.length > 0 ? r.addresses.join(", ") : r.guardians.length === 0 ? "None yet" : "None that can sign in") },
    { key: "customer", header: "Customer", cell: (r) => (r.customer === null ? (r.status.key === "not_checked" ? "Not checked now" : "None")
      : <>{r.customer.name}<span className="when">{r.customer.email ?? "No email address"}</span></>) },
    { key: "status", header: "Status", cell: (r) => <><StatusBadge tone={TONE[r.status.key]}>{STATUS_WORDS[r.status.key]}</StatusBadge><span className="when"><StatusMeta status={r.status} row={r} /></span></> },
    { key: "more", header: "Details", cell: (r) => <Opening row={r} tag={tag} guardianLinks={view.guardianLinks} maySend={maySend} /> },
  ];
  return (
    <main className="wrap single">
      <LinkAnswers>
        <PageHeader title="Accounting links" lede={<>Each family in the portal, beside the customer in the books it&apos;s linked to or looks like.
          Only three things here send anything to the books: Send the app&apos;s to QuickBooks, Send the app&apos;s for all, and a student&apos;s move taken from the books, which voids an unpaid volunteer buy-out invoice of theirs there.</>} />
        <LinkAnswersShown />

        {view.state !== "listed" && <Notice tone="warning" live="none">{WHY_NOT_CHECKED[view.state]}</Notice>}

        {pick !== null && <PickPart view={view} familyId={pick} customerId={customer} cq={cq} tag={tag} made={made} />}

        <CustomersWithNoFamily view={view} mayChangeFamilies={maySend}>
          <ImportOffer proposable={proposable} mayChangeFamilies={maySend} />
        </CustomersWithNoFamily>

        {importAsked && <ImportReview review={maySend && proposable > 0 ? await view.importReview() : null} mayChangeFamilies={maySend} tag={tag} />}

        <Card title="Families" titleId="links-list-h"
          description={<>Link a family this page suggests a customer for here, with Confirm.
            &ldquo;Create a family from this&rdquo; is refused for such a customer, or for one QuickBooks made for a change that was given up.
            &ldquo;Create in QuickBooks and link&rdquo; would make a second customer in the books. It isn&apos;t offered for a family unlinked while its customer is still there.</>}>
          <HowThisWorks summary="How links are made">
            <h3>Linking</h3>
            <ul>
              <li>A customer is suggested only when a guardian&apos;s sign-in address is exactly on a customer no family is linked to: in its email field, or on a parent record under it.</li>
              <li>A name never suggests one. Nor does a customer another family has.</li>
              <li>A blocked guardian&apos;s address is never matched.</li>
              <li>A family the portal has is linked here: Confirm its suggestion, or one of its possible customers, or pick a different customer from those no family is linked to.</li>
              <li>Confirming sends nothing to the books. It also links each student whose name is on exactly one student on each side.</li>
              <li>Where the books have Parent customers, it links each guardian whose sign-in address is in the email field of exactly one Parent customer under it, if that customer holds no other guardian&apos;s address and isn&apos;t linked or kept for anyone. This doesn&apos;t happen while a change for them waits on Reconciliation.</li>
              <li>Students left over show among the row&apos;s differences. An inactive student customer is only counted.</li>
              <li>Leave unlinked keeps a family out of the suggestions until someone undoes it.</li>
            </ul>
            <h3>Many at once</h3>
            <ul>
              <li>Confirm all exact email matches links every Suggested row shown, up to {BULK_MAX}.</li>
              <li>Confirm this link marks a carried-over link as checked by you.</li>
            </ul>
            <h3>Unlinking</h3>
            <ul>
              <li>Unlink from the books ends the family&apos;s link and its students&apos; and guardians&apos; links, and sends nothing. To change customer, unlink, then link again.</li>
            </ul>
            <h3>Guardians</h3>
            <ul>
              <li>A guardian&apos;s own link to a Parent customer is made or ended in the family&apos;s row.</li>
              <li>A Parent customer several guardians share is nobody&apos;s, so nothing is sent for it until only one is left on it.</li>
              <li>A removed guardian&apos;s Parent customer is offered to nobody else.</li>
            </ul>
            <h3>Differences</h3>
            <ul>
              <li>For each linked family, the portal compares names, active or inactive, each student&apos;s family, and records only one side has.
                It compares against its last read of the books{view.readAt ? <> (<LocalTime iso={view.readAt} />)</> : ", though it hasn't read them yet"}.</li>
              <li>A carried-over family with differences is counted under both Carried over and Linked, with differences.</li>
              <li>Take QuickBooks&apos; into the app changes only the portal&apos;s records.</li>
              <li>Send the app&apos;s to QuickBooks (for someone who may also change families) puts the portal&apos;s value in the books. A make-inactive reads the balance first and sends nothing while there is any.</li>
              <li>Send the app&apos;s for all queues every name and student&apos;s family shown, up to {SEND_ALL_MAX}, sent within a few minutes. It skips each make-inactive (send those on their rows), and anything that must wait for another change from the same press (press again).</li>
              <li>Every other difference is only shown.</li>
            </ul>
            <h3>Inactive here, active in the books</h3>
            <ul>
              <li>These are listed after the families. Taking the books&apos; value makes one active again, but its guardians sign in only once someone who may change families lets them in on its page.</li>
              <li>Or make it inactive in the books, everyone under it first.</li>
            </ul>
            <h3>Making new</h3>
            <ul>
              <li>&ldquo;Create a family from this&rdquo; (under Customers with no family) makes a portal family from a customer.</li>
              <li>&ldquo;Create in QuickBooks and link&rdquo; (on a family&apos;s page) makes a customer for a family with none.</li>
              <li>Adding a family on the Roster makes one too, when someone who can link families adds it while the books are connected.</li>
            </ul>
          </HowThisWorks>
          <form method="get" action="/staff/links" role="search">
            <Toolbar label="Filter the families">
              <Select id="links-status" label="Status" name="status" defaultValue={filter.status ?? ""}>
                <option value="">Every status ({view.rows.length})</option>
                {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS_WORDS[k]} ({counts[k]})</option>)}
              </Select>
              <TextInput id="links-q" label="Family name or email address" name="q" type="search" maxLength={SEARCH_MAX} defaultValue={filter.q} autoComplete="off" />
              <Button type="submit" variant="secondary">Show</Button>
              {filtered && <LinkButton variant="quiet" href="/staff/links">Show every family</LinkButton>}
            </Toolbar>
          </form>
          {overlap > 0 && <p>{overlap === 1 ? "1 family whose link was carried over has differences, so it is counted under both Carried over and Linked, with differences."
            : `${overlap} families whose links were carried over have differences, so each is counted under both Carried over and Linked, with differences.`}</p>}
          {bulk !== null && <BulkPress bulk={bulk} filter={filter} tag={tag} />}
          {sendAll !== null && <SendAllPress offer={sendAll} filter={filter} tag={tag} />}
          {filter.tooLong && <Notice tone="warning" live="none">That search was too long, so nothing was searched for. Try a shorter part of a name or an address, up to {SEARCH_MAX} characters.</Notice>}
          {view.rows.length === 0 ? <EmptyState title="The portal has no active families yet." />
            : rows.length === 0 ? <Notice tone="info">No family matches that.</Notice>
            : <DataTable caption={filtered ? `${plural(rows.length, "family", "families")} of ${view.rows.length} shown` : `Every family, by name: ${plural(rows.length, "family", "families")}`}
                columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} />}
        </Card>

        {view.inactive.length > 0 && <InactivePart rows={view.inactive} tag={tag} familyPages={view.familyPages} maySend={maySend} />}
      </LinkAnswers>
    </main>
  );
}
