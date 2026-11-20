import Link from "next/link";
import { requireStaffAlso, requireStaffPage } from "@/lib/guards";
import { filterLinkRows, filtersOf, givenUpCustomersOf, loadAccountingLinks, statusCounts, type ConfirmStep, type LinkMade, type LinkOffer, type LinkRow, type LinkStatus, type LinksState, type LinksView, type OwnLink } from "@/lib/accounting/mapping";
import { differenceKinds, differenceWords, noteSentence, type Difference } from "@/lib/accounting/differences";
import { NOT_A_FAMILY_WORDS, parseLinksFilter, searchMatches, SEARCH_MAX, STATUS_KEYS, STATUS_WORDS, type StatusKey } from "@/lib/accounting/status";
import type { Holder } from "@/lib/accounting/match";
import type { Proposals } from "@/lib/accounting/proposals";
import { recordNameWords } from "@/lib/families/words";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { DataTable, type Column } from "@/app/components/data-table";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { confirmLinkAction, leaveUnlinkedAction, undoLeaveUnlinkedAction } from "./actions";
import { LinkAnswers, LinkAnswersShown, LinkPress } from "./link-press";

export const metadata = { title: "Accounting links" };
export const dynamic = "force-dynamic";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be suggested now, in words. Differences aren't checked in any of these states either. */
const WHY_NOT_CHECKED: Record<Exclude<LinksState, "listed">, string> = {
  no_company: "The portal hasn't read the club's books yet, so no family's link can be checked and nothing is suggested. Each family is listed as not checked. Differences between the portal and the books aren't checked either.",
  other_company: "QuickBooks is connected to a different company than the one the roster was read from, so no link is read and nothing is suggested. Each family is listed as not checked. Differences between the portal and the books aren't checked either. An Admin can see why under Settings, QuickBooks.",
  no_shape: "The membership shape isn't chosen, or names a customer type the books no longer have, so the portal can't tell which customers are families. Links are shown as they are, but nothing is suggested, and a family with no link is listed as not checked. Differences between the portal and the books aren't checked either. An Admin can choose the shape under Settings, QuickBooks.",
};

/** The icon a status carries beside its words: a link that stands, something to look at, or nothing checked or wanted. */
const ICON: Record<StatusKey, "done" | "todo" | "waived"> = {
  carried_over: "done", linked: "done", with_differences: "todo", suggested: "todo", several: "todo", no_match: "todo", left_unlinked: "waived", not_a_family: "todo", customer_gone: "todo", not_checked: "waived",
};

/** At most this many customers are listed at once in the chooser; a search narrows them. */
const CHOOSER_MAX = 50;
/** Where the chooser and the confirm step are drawn, and the list. */
const PICK = "links-pick-h";

const holderWords = (h: Holder) => (h.on.kind === "family" ? `${h.address}, on this customer` : `${h.address}, on ${h.on.name} under it`);

/** How a link was made, in words: carried over from the roster, or by whose press. */
function MadeDetail({ made }: { made: LinkMade }) {
  return made.key === "carried_over" ? <>Carried over from the roster by the portal, on <LocalTime iso={made.at} />. Nobody has confirmed it since.</>
    : made.origin === "confirmed" ? <>Confirmed{made.by ? ` by ${made.by}` : ""}, with Confirm on this page or &ldquo;Create a family from this&rdquo;, on <LocalTime iso={made.at} />.</>
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

/** A student's or guardian's own link, in words. */
const ownLinkWords = (l: OwnLink) => (l.state === "linked" ? `linked to ${l.customer}` : l.state === "gone" ? "linked to a customer that isn't in the books' copy any more"
  : l.state === "none" ? "no link of its own" : "its link can't be checked now");

/** Reconciliation's list of changes, where a change the queue holds is shown with what can be done about it. */
const RECONCILIATION_CHANGES = "/staff/reconciliation#writes-h";

/**
 * One difference, with both values as text, and the change on the write queue that explains it, in the queue's own
 * words with a link to Reconciliation's list (never its buttons). Nothing here settles it.
 */
function DifferenceLine({ d }: { d: Difference }) {
  const w = differenceWords(d);
  const notes = d.kind === "guardians_unlinked" ? d.queue.map((q) => `For ${q.count} of them: ${noteSentence(q.note)}`)
    : d.kind === "student_customer" || d.kind === "parent_customers" || d.queue === null ? [] : [noteSentence(d.queue)];
  return (
    <li>{w.what}. In the portal: {w.portal}. In the books: {w.books}.
      {notes.length > 0 && <> {notes.join(" ")} <Link href={RECONCILIATION_CHANGES}>{notes.length === 1 ? "See the change on Reconciliation" : "See the changes on Reconciliation"}</Link></>}</li>
  );
}

/**
 * What a link press would link with the family, and what it would leave on each side, in words: every pair as "<the
 * record's name> with <the customer's name>", the records and customers left, and that those left aren't linked by it.
 */
function ProposalsShown({ proposals }: { proposals: Proposals }) {
  const { pairs, recordsLeft, customersLeft } = proposals;
  if (pairs.length === 0 && recordsLeft.length === 0 && customersLeft.length === 0) return <p>No student would be linked with it.</p>;
  return (
    <>
      <p>{pairs.length === 0 ? "No student would be linked with it: no name is on exactly one student on each side." : "Students linked with it, by name:"}</p>
      {pairs.length > 0 && <ul>{pairs.map((p) => <li key={String(p.studentId)}>{p.recordName} with {p.customerName}{p.customerActive ? "" : " (inactive in the books)"}</li>)}</ul>}
      {recordsLeft.length > 0 && <><p>Left with no link, of the portal&apos;s students:</p><ul>{recordsLeft.map((r) => <li key={String(r.id)}>{recordNameWords(r.name, "student")}</li>)}</ul></>}
      {customersLeft.length > 0 && <><p>Left with no record in the portal, of the student customers under it in the books:</p><ul>{customersLeft.map((c) => <li key={c.qboId}>{c.name}{c.active ? "" : " (inactive in the books)"}</li>)}</ul></>}
      {(recordsLeft.length > 0 || customersLeft.length > 0) && <p>Students left aren&apos;t linked by this press. Once the family is linked, they show with its row among its differences.</p>}
    </>
  );
}

/** The address of the chooser for a family, or of its confirm step for a customer. */
const pickHref = (familyId: string, customerId?: string) => `/staff/links?pick=${encodeURIComponent(familyId)}${customerId ? `&customer=${encodeURIComponent(customerId)}` : ""}#${PICK}`;

/** The row's opening: the family's active students and its open guardians, each with their own link, then its differences, then what can be done. */
function Opening({ row, tag }: { row: LinkRow; tag: string }) {
  const id = String(row.familyId);
  return (
    <details className="more"><summary>{row.differences.length > 0 ? "Students, guardians and differences" : "Students and guardians"}<span className="visually-hidden">: {row.name}</span></summary>
      <p>{row.students.length === 0 ? "No active students." : "Students:"}</p>
      {row.students.length > 0 && <ul>{row.students.map((s) => <li key={String(s.id)}>{s.name}: {ownLinkWords(s.link)}</li>)}</ul>}
      <p>{row.guardians.length === 0 ? "No guardians." : "Guardians:"}</p>
      {row.guardians.length > 0 && <ul>{row.guardians.map((g) => <li key={g.id}>{g.name} ({g.email}){g.blocked ? ", can't sign in, so this address isn't matched" : ""}: {ownLinkWords(g.link)}</li>)}</ul>}
      {row.status.key === "several" && <><p>Possible customers:</p><ul>{row.status.candidates.map((c) => <li key={c.qboId}>{c.name}{c.email ? ` (${c.email})` : ""} <Link href={pickHref(id, c.qboId)}>Look at it before linking<span className="visually-hidden">: {c.name}</span></Link></li>)}</ul></>}
      {row.status.key === "several" && row.status.alsoMatches.length > 0 && <p>Also matched by: {row.status.alsoMatches.join(", ")}.</p>}
      {row.differences.length > 0 && <><p>Where the portal and the books differ:</p><ul>{row.differences.map((d, i) => <DifferenceLine key={i} d={d} />)}</ul></>}
      {row.inactiveUnrecorded > 0 && <p>The books also have {plural(row.inactiveUnrecorded, "inactive student customer", "inactive student customers")} under this family with no student record in the portal.</p>}
      {row.confirm !== null && row.customer !== null && <><p>Confirming links it to &ldquo;{row.customer.name}&rdquo;. Nothing is sent to the books.</p><ProposalsShown proposals={row.confirm.proposals} /></>}
      {row.offers.pick && <p className="link-line"><Link href={pickHref(id)}>Pick a different customer<span className="visually-hidden">: {row.name}</span></Link></p>}
      {(row.confirm !== null || row.offers.leave || row.offers.undo) && (
        <div className="row-actions">
          {row.confirm !== null && <ConfirmPress familyId={id} about={row.name} offer={row.confirm} tag={tag} />}
          {row.offers.leave && <LinkPress label="Leave unlinked" busy="Leaving it unlinked…" about={row.name} act={leaveUnlinkedAction.bind(null, id, tag)} />}
          {row.offers.undo && <LinkPress label="Undo Left unlinked" busy="Undoing…" about={row.name} act={undoLeaveUnlinkedAction.bind(null, id, tag)} />}
        </div>
      )}
    </details>
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
    <section className="box" aria-labelledby={PICK}><h2 id={PICK}>A customer for {row.name}</h2>
      {made.map((m) => <Notice key={m.queueId} tone="info" live="none">Making this family in the books was given up after a try the books may have taken, and they have the customer &ldquo;{m.name}&rdquo; from it, with no family linked to it. If it is this family, picking it ties the two together.</Notice>)}
      {step !== null && !step.ok && <Notice tone="warning" live="none">{step.why === "customer" ? "That customer isn't one with no family in the portal now, so it can't be linked here. Pick another from the list." : "That customer can't be linked to this family from here now."}</Notice>}
      {step !== null && step.ok && (
        <div className="stack">
          <h3>Link {step.family} to &ldquo;{step.customer.name}&rdquo;?</h3>
          <p>{CHOSEN_WORDS[step.offer.chosen]} Its email field in the books: {step.customer.email ?? "none"}.</p>
          {step.alsoFor.length > 0 && <Notice tone="warning" live="none">This page also suggests this customer for, or lists it as a possible customer of, {step.alsoFor.join(", ")}. A customer can be linked to only one family: link it to the one it really is.</Notice>}
          <ProposalsShown proposals={step.offer.proposals} />
          <p>Nothing is sent to the books. The family&apos;s guardians&apos; own records in the books aren&apos;t linked by this.</p>
          <div className="row-actions"><ConfirmPress familyId={id} about={row.name} offer={step.offer} tag={tag} /></div>
        </div>
      )}
      <form method="get" action="/staff/links" role="search" className="matrix-filter">
        <input type="hidden" name="pick" value={id} />
        <label className="field"><span>Customer name or email address</span><input name="cq" type="search" maxLength={SEARCH_MAX} defaultValue={cq} autoComplete="off" /></label>
        <div className="matrix-filter-go"><button type="submit" className="btn btn-line">Search</button><Link href="/staff/links">Close</Link></div>
      </form>
      {view.pool.length === 0 ? <Notice tone="info" live="none">Every customer the books list as a family is linked to a family in the portal already, so there is none to pick.</Notice>
        : found.length === 0 ? <Notice tone="info">No customer with no family matches that.</Notice>
        : <DataTable caption={found.length > shown.length ? `${shown.length} of ${plural(found.length, "customer", "customers")} with no family that match: search to narrow them` : `${plural(found.length, "customer", "customers")} with no family`}
            columns={columns} rows={shown} rowKey={(c) => c.qboId} />}
    </section>
  );
}

/**
 * Accounting links (stage 4's slices M1 to M3a of the app-owned families spec, section 4, "The mapping screen"): every
 * active family, its link to its customer in the books and how that link stands, or the customer that looks like its
 * own, with a status on each row, a filter by status and a search. Since slice M3a a family with no link is linked here
 * (Confirm its suggestion or a candidate, or Pick a different customer), or left unlinked, and nothing is sent to the
 * books; each press is audited, in its own transaction (src/lib/accounting/link-writes.ts). For holders of the linking
 * permission (Accounting.Link.ReadWrite, not Admin-only), who also need Roster.Read, checked here and refused as the
 * guard refuses (requireStaffAlso()): a role written with patterns can hold the first without the second. The page
 * lists many families, so neither the page, a row's opening, the chooser nor the confirm step is audited as a read of
 * one family, as Reconciliation isn't; each family's own page is. A server component: the books' text (names, email
 * fields) is rendered as text, and the presses are bound actions in a small client component given only their words.
 */
export default async function AccountingLinksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Accounting.Link.ReadWrite");
  await requireStaffAlso(ctx, "Roster.Read");
  const sp = await searchParams;
  const filter = parseLinksFilter(sp);
  // Read before the roster: a press made on this page is refused when the roster was read from another company since.
  const tag = await currentRosterTag();
  const view = await loadAccountingLinks();
  const counts = statusCounts(view.rows);
  // A carried-over family with differences is found under two filters (filtersOf()), so the counts overlap by this many.
  const overlap = view.rows.filter((r) => filtersOf(r).length > 1).length;
  const rows = filterLinkRows(view.rows, filter);
  const filtered = filter.status !== null || filter.q !== "";
  const pick = typeof sp.pick === "string" && sp.pick.length <= 64 ? sp.pick : null;
  const customer = typeof sp.customer === "string" && sp.customer.length <= 64 ? sp.customer : null;
  const cq = typeof sp.cq === "string" && sp.cq.trim().length <= SEARCH_MAX ? sp.cq.trim() : "";
  // A create of the picking family given up after a try the books may have taken, whose customer stands with no family linked to it.
  const pickRow = pick === null ? undefined : view.rows.find((r) => String(r.familyId) === pick.toLowerCase() && r.offers.pick);
  const made = pickRow === undefined ? [] : await givenUpCustomersOf(pickRow.familyId, view);
  const columns: Column<LinkRow>[] = [
    { key: "family", header: "Family", rowHeader: true, sorted: "ascending", cell: (r) => (view.familyPages ? <Link href={familyPage(r.familyId)}>{r.name}</Link> : r.name) },
    { key: "addresses", header: "Guardians' sign-in addresses", cell: (r) => (r.addresses.length > 0 ? r.addresses.join(", ") : r.guardians.length === 0 ? "None yet" : "None that can sign in") },
    { key: "customer", header: "Customer in the books", cell: (r) => (r.customer === null ? (r.status.key === "not_checked" ? "Not checked now" : "None")
      : <>{r.customer.name}<span className="when">{r.customer.email ?? "No email address"}</span></>) },
    { key: "status", header: "Status", cell: (r) => <><StateWords state={ICON[r.status.key]} words={STATUS_WORDS[r.status.key]} /><span className="when"><StatusDetail status={r.status} row={r} /></span></> },
    { key: "more", header: "Students and guardians", cell: (r) => <Opening row={r} tag={tag} /> },
  ];
  return (
    <main className="wrap single">
      <LinkAnswers>
        <h1 className="page-title">Accounting links</h1>
        <p className="lede">Every family in the portal, beside the customer in the books it is linked to, or the one that looks like its own.
          A family with no link can be linked here, to its suggestion or a customer you pick, or left unlinked. Nothing here is sent to the books.
          For a family whose link stands, it also lists where the portal and the books differ, and settles none of it.</p>
        <LinkAnswersShown />

        <section className="box" aria-labelledby="links-how-h"><h2 id="links-how-h">How links are made</h2>
          <p>A customer is suggested only when one of the family&apos;s guardians signs in with an address that is, exactly, on a customer no family is linked to:
            in its own email field, or on a parent record under it. A name never suggests a customer, and a customer another family is linked to is never suggested.
            A guardian who can&apos;t sign in, because they are blocked, is listed under the family, but their address is never matched.</p>
          <p>A family the portal has is linked here: Confirm its suggestion, or one of its possible customers, or pick a different customer from those no family is linked to.
            Nothing is sent to the books: the press ties the family to its customer in the portal, with each of its students whose name is on exactly one student on each side.
            Students left that way aren&apos;t linked, and show with the family&apos;s row among its differences. Leave unlinked keeps a family out of the suggestions until someone undoes it.</p>
          <p>A link also comes with something new. &ldquo;Create a family from this&rdquo;, on Reconciliation, makes a new family in the portal from a customer no family is linked to.
            &ldquo;Create in QuickBooks and link&rdquo;, on a family&apos;s page, makes a new customer in the books for a family that has none, and so does adding a family under Families, when someone who may link families adds it while the books are connected.</p>
          <p>For each family whose link stands, the portal compares the names, whether each is active, the family each student is under, and the students and Parent customers only one side has,
            against its copy of the books{view.readAt ? <>, from its last read of them on <LocalTime iso={view.readAt} /></> : ", though it hasn't read the books yet"}.
            A family whose link was carried over and that has differences is found under both Carried over and Linked, with differences, and counted under both.</p>
          <Notice tone="warning" live="none">For a family this page suggests a customer for, or lists possible customers of, link it here with Confirm.
            &ldquo;Create a family from this&rdquo; on Reconciliation, for that customer, would still make a second family beside the one the portal has, so don&apos;t use it for one.
            And &ldquo;Create in QuickBooks and link&rdquo; on the family&apos;s page would make a second customer in the books for a family whose customer is already there.</Notice>
          {view.noFamily !== null && (
            <p>{view.noFamily === 0 ? "Every active customer the books list as a family at the top level, under no other customer, is linked to a family in the portal, or is about to be by a change on Reconciliation."
              : `${plural(view.noFamily, "active customer the books list as a family at the top level, under no other customer, has", "active customers the books list as a family at the top level, under no other customer, have")} no family in the portal.`}
              {" "}<Link href="/staff/reconciliation#no-family-h">See the customers with no family on Reconciliation</Link></p>
          )}
        </section>

        {view.state !== "listed" && <Notice tone="warning" live="none">{WHY_NOT_CHECKED[view.state]}</Notice>}

        {pick !== null && <PickPart view={view} familyId={pick} customerId={customer} cq={cq} tag={tag} made={made} />}

        <section className="box" aria-labelledby="links-list-h"><h2 id="links-list-h">Families</h2>
          <form method="get" action="/staff/links" role="search" className="matrix-filter">
            <label className="field"><span>Status</span>
              <select name="status" defaultValue={filter.status ?? ""}>
                <option value="">Every status ({view.rows.length})</option>
                {STATUS_KEYS.map((k) => <option key={k} value={k}>{STATUS_WORDS[k]} ({counts[k]})</option>)}
              </select></label>
            <label className="field"><span>Family name or email address</span><input name="q" type="search" maxLength={SEARCH_MAX} defaultValue={filter.q} autoComplete="off" /></label>
            <div className="matrix-filter-go"><button type="submit" className="btn btn-line">Show</button>{filtered && <Link href="/staff/links">Show every family</Link>}</div>
          </form>
          {overlap > 0 && <p>{overlap === 1 ? "1 family whose link was carried over has differences, so it is counted under both Carried over and Linked, with differences."
            : `${overlap} families whose links were carried over have differences, so each is counted under both Carried over and Linked, with differences.`}</p>}
          {filter.tooLong && <Notice tone="warning" live="none">That search was too long, so nothing was searched for. Try a shorter part of a name or an address, up to {SEARCH_MAX} characters.</Notice>}
          {view.rows.length === 0 ? <Notice tone="info" live="none">The portal has no active families yet.</Notice>
            : rows.length === 0 ? <Notice tone="info">No family matches that.</Notice>
            : <DataTable caption={filtered ? `${plural(rows.length, "family", "families")} of ${view.rows.length} shown` : `Every family, by name: ${plural(rows.length, "family", "families")}`}
                columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} />}
        </section>
      </LinkAnswers>
    </main>
  );
}
