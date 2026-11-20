import Link from "next/link";
import { requireStaffAlso, requireStaffPage } from "@/lib/guards";
import { filterLinkRows, loadAccountingLinks, statusCounts, type LinkRow, type LinkStatus, type LinksState, type OwnLink } from "@/lib/accounting/mapping";
import { NOT_A_FAMILY_WORDS, parseLinksFilter, SEARCH_MAX, STATUS_KEYS, STATUS_WORDS, type StatusKey } from "@/lib/accounting/status";
import type { Holder } from "@/lib/accounting/match";
import { DataTable, type Column } from "@/app/components/data-table";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";
import { familyPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Accounting links" };
export const dynamic = "force-dynamic";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be suggested now, in words. */
const WHY_NOT_CHECKED: Record<Exclude<LinksState, "listed">, string> = {
  no_company: "The portal hasn't read the club's books yet, so no family's link can be checked and nothing is suggested. Each family is listed as not checked.",
  other_company: "QuickBooks is connected to a different company than the one the roster was read from, so no link is read and nothing is suggested. Each family is listed as not checked. An Admin can see why under Settings, QuickBooks.",
  no_shape: "The membership shape isn't chosen, or names a customer type the books no longer have, so the portal can't tell which customers are families. Links are shown as they are, but nothing is suggested, and a family with no link is listed as not checked. An Admin can choose the shape under Settings, QuickBooks.",
};

/** The icon a status carries beside its words: a link that stands, something to look at, or nothing checked. */
const ICON: Record<StatusKey, "done" | "todo" | "waived"> = {
  carried_over: "done", linked: "done", suggested: "todo", several: "todo", no_match: "todo", not_a_family: "todo", customer_gone: "todo", not_checked: "waived",
};

const holderWords = (h: Holder) => (h.on.kind === "family" ? `${h.address}, on this customer` : `${h.address}, on ${h.on.name} under it`);

/** What a status means for the row, in words. Every name and address is the books' text or a person's, shown as text. */
function StatusDetail({ status, row }: { status: LinkStatus; row: LinkRow }) {
  switch (status.key) {
    case "carried_over": return <>Carried over from the roster by the portal, on <LocalTime iso={status.at} />. Nobody has confirmed it since.</>;
    case "linked": return <>{status.origin === "confirmed" ? "Confirmed with “Create a family from this”" : "Made in the books from the portal"}{status.by ? ` by ${status.by}` : ""}, on <LocalTime iso={status.at} />.</>;
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
    case "not_checked": return <>The books can&apos;t be checked now, so nothing is suggested.</>;
  }
}

/** A student's or guardian's own link, in words. */
const ownLinkWords = (l: OwnLink) => (l.state === "linked" ? `linked to ${l.customer}` : l.state === "gone" ? "linked to a customer that isn't in the books' copy any more"
  : l.state === "none" ? "no link of its own" : "its link can't be checked now");

/** The row's opening: the family's active students and its open guardians, each with their own link. */
function Opening({ row }: { row: LinkRow }) {
  return (
    <details className="more"><summary>Students and guardians<span className="visually-hidden">: {row.name}</span></summary>
      <p>{row.students.length === 0 ? "No active students." : "Students:"}</p>
      {row.students.length > 0 && <ul>{row.students.map((s) => <li key={String(s.id)}>{s.name}: {ownLinkWords(s.link)}</li>)}</ul>}
      <p>{row.guardians.length === 0 ? "No guardians." : "Guardians:"}</p>
      {row.guardians.length > 0 && <ul>{row.guardians.map((g) => <li key={g.id}>{g.name} ({g.email}){g.blocked ? ", can't sign in, so this address isn't matched" : ""}: {ownLinkWords(g.link)}</li>)}</ul>}
      {row.status.key === "several" && <><p>Possible customers:</p><ul>{row.status.candidates.map((c, i) => <li key={i}>{c.name}{c.email ? ` (${c.email})` : ""}</li>)}</ul></>}
      {row.status.key === "several" && row.status.alsoMatches.length > 0 && <p>Also matched by: {row.status.alsoMatches.join(", ")}.</p>}
    </details>
  );
}

/**
 * Accounting links (stage 4's slice M1 of the app-owned families spec, section 4, "The mapping screen"): every active
 * family, its link to its customer in the books and how that link stands, or the customer that looks like its own,
 * with a status on each row, a filter by status and a search. It only shows: nothing here links, stores, sends or
 * audits anything. For holders of the linking permission (Accounting.Link.ReadWrite, not Admin-only), who also need
 * Roster.Read, checked here and refused as the guard refuses (requireStaffAlso()): a role written with patterns can hold the first without the second. The page lists many
 * families, so neither the page nor a row's opening is audited as a read of one family, as Reconciliation isn't; each
 * family's own page is. A server component only: the books' text (names, email fields) is rendered as text.
 */
export default async function AccountingLinksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Accounting.Link.ReadWrite");
  await requireStaffAlso(ctx, "Roster.Read");
  const filter = parseLinksFilter(await searchParams);
  const view = await loadAccountingLinks();
  const counts = statusCounts(view.rows);
  const rows = filterLinkRows(view.rows, filter);
  const filtered = filter.status !== null || filter.q !== "";
  const columns: Column<LinkRow>[] = [
    { key: "family", header: "Family", rowHeader: true, sorted: "ascending", cell: (r) => (view.familyPages ? <Link href={familyPage(r.familyId)}>{r.name}</Link> : r.name) },
    { key: "addresses", header: "Guardians' sign-in addresses", cell: (r) => (r.addresses.length > 0 ? r.addresses.join(", ") : r.guardians.length === 0 ? "None yet" : "None that can sign in") },
    { key: "customer", header: "Customer in the books", cell: (r) => (r.customer === null ? (r.status.key === "not_checked" ? "Not checked now" : "None")
      : <>{r.customer.name}<span className="when">{r.customer.email ?? "No email address"}</span></>) },
    { key: "status", header: "Status", cell: (r) => <><StateWords state={ICON[r.status.key]} words={STATUS_WORDS[r.status.key]} /><span className="when"><StatusDetail status={r.status} row={r} /></span></> },
    { key: "more", header: "Students and guardians", cell: (r) => <Opening row={r} /> },
  ];
  return (
    <main className="wrap single">
      <h1 className="page-title">Accounting links</h1>
      <p className="lede">Every family in the portal, beside the customer in the books it is linked to, or the one that looks like its own.
        This page only shows: nothing here links a family or changes anything.</p>

      <section className="box" aria-labelledby="links-how-h"><h2 id="links-how-h">How links are made today</h2>
        <p>A customer is suggested only when one of the family&apos;s guardians signs in with an address that is, exactly, on a customer no family is linked to:
          in its own email field, or on a parent record under it. A name never suggests a customer, and a customer another family is linked to is never suggested.
          A guardian who can&apos;t sign in, because they are blocked, is listed under the family, but their address is never matched.</p>
        <p>Nothing in the portal can yet link a family it has already to a customer the books have already, so a suggestion can&apos;t be acted on for now.
          Today a link comes only with something new. &ldquo;Create a family from this&rdquo;, on Reconciliation, makes a new family in the portal from a customer no family is linked to.
          &ldquo;Create in QuickBooks and link&rdquo;, on a family&apos;s page, makes a new customer in the books for a family that has none, and so does adding a family under Families, when someone who may link families adds it while the books are connected.</p>
        <Notice tone="warning" live="none">Don&apos;t use either for a family that reads Suggested or Several possible: &ldquo;Create a family from this&rdquo; on its customer would make a second family beside it,
          and &ldquo;Create in QuickBooks and link&rdquo; on its page would make a second customer in the books.</Notice>
        {view.noFamily !== null && (
          <p>{view.noFamily === 0 ? "Every active customer the books list as a family at the top level, under no other customer, is linked to a family in the portal, or is about to be by a change on Reconciliation."
            : `${plural(view.noFamily, "active customer the books list as a family at the top level, under no other customer, has", "active customers the books list as a family at the top level, under no other customer, have")} no family in the portal.`}
            {" "}<Link href="/staff/reconciliation#no-family-h">See the customers with no family on Reconciliation</Link></p>
        )}
      </section>

      {view.state !== "listed" && <Notice tone="warning" live="none">{WHY_NOT_CHECKED[view.state]}</Notice>}

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
        {filter.tooLong && <Notice tone="warning" live="none">That search was too long, so nothing was searched for. Try a shorter part of a name or an address, up to {SEARCH_MAX} characters.</Notice>}
        {view.rows.length === 0 ? <Notice tone="info" live="none">The portal has no active families yet.</Notice>
          : rows.length === 0 ? <Notice tone="info">No family matches that.</Notice>
          : <DataTable caption={filtered ? `${plural(rows.length, "family", "families")} of ${view.rows.length} shown` : `Every family, by name: ${plural(rows.length, "family", "families")}`}
              columns={columns} rows={rows} rowKey={(r) => String(r.familyId)} />}
      </section>
    </main>
  );
}
