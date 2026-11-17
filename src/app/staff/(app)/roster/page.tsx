import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage } from "@/lib/roster/queries";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { rosterCounts } from "../settings/quickbooks/roster-counts";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { DisconnectedNotice, Freshness } from "./freshness";
import { CreateBox, WhatChanges } from "./changes";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

type Row = { id: string; name: string; students: number | null; parents: number | null; active: boolean };
const entryHref = (id: string) => `/staff/roster/${encodeURIComponent(id)}`;

export default async function RosterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : Array.isArray(sp.q) ? sp.q[0] ?? "" : "").trim().slice(0, 100);
  const q = typed.toLowerCase();
  // The tag first: the roster the page then shows is that company's or a later one, never an earlier one.
  const rosterTag = await currentRosterTag();
  const page = await loadRosterPage();
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected;
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  const settings = admin ? <> <a href="/staff/settings/quickbooks">Open QuickBooks settings</a></> : " An Admin can do that under QuickBooks.";
  const matches = (name: string) => !q || name.toLowerCase().includes(q); // a plain substring: nothing typed is a pattern
  const roster = page.lastOkAt ? page.roster : null; // a shape with no successful read has nothing real to list
  const unread = Boolean(page.roster && !page.lastOkAt);
  const rows: Row[] = !roster ? [] : roster.kind === "flat"
    ? roster.members.filter((m) => matches(m.displayName)).map((m) => ({ id: m.qboId, name: m.displayName, students: null, parents: null, active: m.active }))
    : roster.families.filter((f) => matches(f.customer.displayName)).map((f) => ({ id: f.customer.qboId, name: f.customer.displayName,
        students: f.students.length, parents: f.parents.length, active: f.customer.active }));
  const hasPage = new Set(!roster ? [] : roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));
  const noun = roster?.kind === "flat" ? "member" : "family";
  const nouns = roster?.kind === "flat" ? "members" : "families";
  const columns: Column<Row>[] = [
    { key: "name", header: roster?.kind === "flat" ? "Member" : "Family", rowHeader: true, sorted: "ascending", cell: (r) => <a href={entryHref(r.id)}>{r.name}</a> },
    ...(roster?.kind === "flat" ? [] : [
      { key: "students", header: "Students", numeric: true, cell: (r: Row) => r.students },
      { key: "parents", header: "Parents", numeric: true, cell: (r: Row) => r.parents },
    ]),
    { key: "status", header: "In QuickBooks", cell: (r) => (r.active ? "Active" : "Inactive") },
  ];
  return (
    <main className="wrap single">
      <h1 className="page-title">Roster</h1>
      <p className="lede">The club&apos;s {roster?.kind === "flat" ? "members" : "families"} as QuickBooks lists them. This is a copy of what QuickBooks holds: a change made here is sent to QuickBooks first.</p>

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
            ? <Notice tone="info">{typed ? <>No {noun} matches &quot;{typed}&quot;.</> : roster.kind === "flat" ? "QuickBooks lists no customers of the member types." : "QuickBooks lists no customers of the family type."}</Notice>
            : <DataTable caption={typed ? <>{rows.length} {rows.length === 1 ? noun : nouns} matching &quot;{typed}&quot;</> : <>Every {noun} on the roster, by name</>}
                columns={columns} rows={rows} rowKey={(r) => r.id} />}
        </section>
      )}

      {roster && page.shape && canChange && <CreateBox shape={page.shape} rosterTag={rosterTag}
        memberTypes={page.shape.kind === "flat" ? page.shape.memberTypeIds.map((t) => ({ qboId: t, name: page.types.find((x) => x.qboId === t)?.name ?? "A member type" })) : []} />}
      {roster && page.shape && <WhatChanges shape={page.shape} canChange={canChange} />}

      {roster && page.attention.length > 0 && (
        <section className="box" aria-labelledby="roster-attn-h"><h2 id="roster-attn-h">Needs attention ({page.attention.length})</h2>
          <p>Things to tidy up in QuickBooks, or in the portal&apos;s sign-ins. Nothing here is changed by itself: fix each in QuickBooks, or from a family&apos;s page.</p>
          <DataTable caption="What to tidy, for each customer" captionHidden rowKey={(a) => a.key} rows={page.attention.map((a, i) => ({ ...a, key: `${a.rule}-${a.qboId ?? a.name}-${i}` }))}
            columns={[
              { key: "name", header: "Customer", rowHeader: true, cell: (a) => (a.qboId && hasPage.has(a.qboId) ? <a href={entryHref(a.qboId)}>{a.name}</a> : a.name) },
              { key: "detail", header: "What to tidy", cell: (a) => a.detail },
            ]} />
        </section>
      )}

      <Freshness page={page} admin={admin} />
    </main>
  );
}
