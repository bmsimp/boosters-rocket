import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage, rosterFamilies } from "@/lib/roster/queries";
import { connectedToAnotherCompany, linksOfCustomers } from "@/lib/families/links";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { rosterCounts } from "../settings/quickbooks/roster-counts";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { DisconnectedNotice, Freshness } from "./freshness";
import { CreateBox, WhatChanges } from "./changes";
import { familyPage } from "@/app/staff/(app)/family-pages";
import type { AppFamilyId } from "@/lib/families/ids";
import { familiesBeingMade } from "@/lib/roster/writes";
import { endedLinksHeld } from "@/lib/accounting/ended-links";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

/**
 * `status`: the customer's own standing in QuickBooks; null for a family the roster lists no customer for. `linked`:
 * the family has a link at all; `making`: it has none yet, and its own create is waiting on the queue (stage 3's slice 9d);
 * `held`: it has none since it was unlinked, and its customer is still in the books (stage 4's slice M3b2,
 * endedLinksHeld()). The row names the family only, never that customer.
 */
type Row = { id: AppFamilyId; name: string; students: number | null; parents: number | null; status: boolean | null; linked: boolean; making: boolean; held: boolean };
/** Whether a family is linked to QuickBooks, in words, and its customer's standing there when it is. */
const linkWords = (r: Row) => (r.status !== null ? (r.status ? "Linked: active" : "Linked: inactive") : r.linked ? "Linked: not listed as a family now"
  : r.making ? "Not linked yet: being made in QuickBooks" : r.held ? "Not linked: its customer is still in the books" : "Not linked: in the portal only");

export default async function RosterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : Array.isArray(sp.q) ? sp.q[0] ?? "" : "").trim().slice(0, 100);
  const q = typed.toLowerCase();
  // The tag first: the roster the page then shows is that company's or a later one, never an earlier one.
  const rosterTag = await currentRosterTag();
  const page = await loadRosterPage();
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected;
  // Adding a family is the portal's own (stage 3's slice 9d): offered wherever the list is, connected or not, and made
  // in QuickBooks too only by staff who may link families to accounting while QuickBooks is connected.
  // Not while QuickBooks is connected to another company than the roster's: addFamily() refuses then (WRITE_COPY.noRoster).
  const mayAdd = can(ctx.effective, "Roster.Family.ReadWrite") && !(await connectedToAnotherCompany());
  const goes = !can(ctx.effective, "Accounting.Link.ReadWrite") ? "no_permission" as const : page.connected ? "sends" as const : "not_connected" as const;
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  const settings = admin ? <> <a href="/staff/settings/quickbooks">Open QuickBooks settings</a></> : " An Admin can do that under QuickBooks.";
  const matches = (name: string) => !q || name.toLowerCase().includes(q); // a plain substring: nothing typed is a pattern
  const roster = page.lastOkAt ? page.roster : null; // a shape with no successful read has nothing real to list
  const unread = Boolean(page.roster && !page.lastOkAt);
  // The families are the app's own records (stage 3 of the app-owned families spec), each with what QuickBooks holds
  // for its customer, from the roster read above: every one has a page, addressed by its record.
  const families = roster ? await rosterFamilies(page) ?? [] : [];
  const making = families.some((f) => !f.linked) ? await familiesBeingMade() : new Set<string>();
  // Those with no link unlinked from a customer the books still hold (slice M3b2): one read for them all, none when there are none.
  const held = (await endedLinksHeld({ families: families.filter((f) => !f.linked).map((f) => f.id) })).families;
  const rows: Row[] = families.filter((f) => matches(f.name)).map((f) => ({ id: f.id, name: f.name,
    students: roster?.kind === "flat" ? null : f.students.length, parents: roster?.kind === "flat" ? null : f.parents.length, status: f.customer?.active ?? null,
    linked: f.linked, making: making.has(String(f.id)), held: held.has(f.id) }));
  // Needs attention names QuickBooks' customers: each family's (or member's) is linked to its page through the family
  // kind of link, for the whole list in one lookup; a customer with none has no page, and its name links nowhere.
  const withPage = !roster ? [] : roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId);
  const pageOf = (await linksOfCustomers({ families: withPage, students: [] })).familyOfCustomer;
  const named = (qboId: string | null, name: string) => { const at = qboId === null ? undefined : pageOf.get(qboId); return at ? <a href={familyPage(at)}>{name}</a> : name; };
  // The rows are records, which no read of QuickBooks makes (stage 3's slice 9c): a customer added in QuickBooks, or a
  // cache read before the portal recorded its company (shown while QuickBooks is disconnected), lists customers the
  // records don't hold.
  const listedInCache = !roster ? 0 : roster.kind === "flat" ? roster.members.length : roster.families.length;
  const noun = roster?.kind === "flat" ? "member" : "family";
  const nouns = roster?.kind === "flat" ? "members" : "families";
  const columns: Column<Row>[] = [
    { key: "name", header: roster?.kind === "flat" ? "Member" : "Family", rowHeader: true, sorted: "ascending", cell: (r) => <a href={familyPage(r.id)}>{r.name}</a> },
    ...(roster?.kind === "flat" ? [] : [
      { key: "students", header: "Students", numeric: true, cell: (r: Row) => r.students },
      { key: "parents", header: "Parents", numeric: true, cell: (r: Row) => r.parents },
    ]),
    { key: "status", header: "In QuickBooks", cell: linkWords },
  ];
  return (
    <main className="wrap single">
      <h1 className="page-title">Roster</h1>
      <p className="lede">The club&apos;s {roster?.kind === "flat" ? "members" : "families"}, each beside its customer in QuickBooks where it is linked to one. A change to a linked {roster?.kind === "flat" ? "member" : "family"} is sent to QuickBooks first, then made here too; one with no link is changed here only; and a change made in QuickBooks doesn&apos;t change the portal&apos;s {roster?.kind === "flat" ? "members" : "families"}.</p>

      {!roster && (
        <Notice tone={page.brokenTypes.length ? "warning" : "info"} title="Nothing to show yet" titleId="roster-none-h">
          <p>{page.brokenTypes.length ? <>The membership shape names a customer type QuickBooks no longer has, so the roster can&apos;t be shown until the shape is chosen again.{settings}</>
            : unread ? <>The roster hasn&apos;t been read from QuickBooks yet.</>
            : page.connected ? <>The membership shape hasn&apos;t been chosen yet.{settings}</>
            : <>QuickBooks isn&apos;t connected yet.{settings}</>}</p>
        </Notice>
      )}

      {roster && <DisconnectedNotice page={page} admin={admin} />}
      {roster && (
        <section className="box" aria-labelledby="roster-list-h"><h2 id="roster-list-h">{roster.kind === "flat" ? "Members" : "Families"}</h2>
          <p>{rosterCounts(roster)}</p>
          <form method="get" role="search" className="stack">
            <label className="field"><span>Find a {noun}</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
            <button className="btn btn-line">Find</button>
          </form>
          {rows.length === 0
            ? <Notice tone="info">{typed ? <>No {noun} matches &quot;{typed}&quot;.</>
                : listedInCache > 0 ? <>QuickBooks lists {nouns}, but none of them is one of the portal&apos;s own {nouns}: a read of QuickBooks doesn&apos;t bring customers into the portal.</>
                : roster.kind === "flat" ? "QuickBooks lists no customers of the member types." : "QuickBooks lists no customers of the family type."}</Notice>
            : <DataTable caption={typed ? <>{rows.length} {rows.length === 1 ? noun : nouns} matching &quot;{typed}&quot;</> : <>Every {noun} on the roster, by name</>}
                columns={columns} rows={rows} rowKey={(r) => String(r.id)} />}
        </section>
      )}

      {/* Not while the cache names no company (read before the portal recorded it): addFamily() refuses there. */}
      {roster && page.shape && mayAdd && rosterTag !== "none" && <CreateBox shape={page.shape} rosterTag={rosterTag} goes={goes}
        memberTypes={page.shape.kind === "flat" ? page.shape.memberTypeIds.map((t) => ({ qboId: t, name: page.types.find((x) => x.qboId === t)?.name ?? "A member type" })) : []} />}
      {roster && page.shape && <WhatChanges shape={page.shape} canChange={canChange} />}

      {roster && page.attention.length > 0 && (
        <section className="box" aria-labelledby="roster-attn-h"><h2 id="roster-attn-h">Needs attention ({page.attention.length})</h2>
          <p>Things to tidy up in QuickBooks, or in the portal&apos;s sign-ins. Nothing here is changed by itself: fix each in QuickBooks, or from a family&apos;s page.</p>
          <DataTable caption="What to tidy, for each customer" captionHidden rowKey={(a) => a.key} rows={page.attention.map((a, i) => ({ ...a, key: `${a.rule}-${a.qboId ?? a.name}-${i}` }))}
            columns={[
              { key: "name", header: "Customer", rowHeader: true, cell: (a) => named(a.qboId, a.name) },
              { key: "detail", header: "What to tidy", cell: (a) => a.detail },
            ]} />
        </section>
      )}

      <Freshness page={page} admin={admin} />
    </main>
  );
}
