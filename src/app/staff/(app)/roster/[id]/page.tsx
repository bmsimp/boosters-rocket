// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadRosterPage, familyEntry } from "@/lib/roster/queries";
import { familyRecordAt } from "@/lib/families/address";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyCover, versionsOf } from "@/lib/roster/writes";
import { loadOpenWrites } from "@/lib/roster/queue";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { familySignins, type FamilySignin } from "@/lib/parents/directory";
import { DisconnectedNotice, Freshness } from "../freshness";
import { FamilyChanges, MemberChanges, Waiting, WhatChanges } from "../changes";
import type { Cust } from "@/lib/roster/model";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { familyBalancePage, familyBuyoutsPage, familyCreditPage, familyProgressPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

const standing = (c: Cust) => (c.active ? "Active" : "Inactive");

/**
 * The people QuickBooks lists under the family (or the member alone), as a table: a name per row, then what QuickBooks
 * holds for them. Names, emails and phones are QuickBooks text, shown as text only.
 */
function People({ id, title, noun, people, contact, empty }: { id: string; title: string; noun: string; people: Cust[]; contact: boolean; empty: string }) {
  const columns: Column<Cust>[] = [
    { key: "name", header: noun, rowHeader: true, cell: (p) => p.displayName },
    ...(contact ? [
      { key: "email", header: "Email", cell: (p: Cust) => p.email ?? "No email address" },
      { key: "phone", header: "Phone", cell: (p: Cust) => p.phone ?? "No phone number" },
    ] : []),
    { key: "status", header: "In QuickBooks", cell: standing },
  ];
  return (
    <section className="box" aria-labelledby={id}><h2 id={id}>{title}</h2>
      {people.length === 0 ? <Notice tone="info" live="none">{empty}</Notice>
        : <DataTable caption={title} captionHidden columns={columns} rows={people} rowKey={(p) => p.qboId} />}
    </section>
  );
}

/** `detailed` is for staff with `Parents.ReadWrite`: only they see which other family a held address is under, and get links to people. */
function SignIns({ signins, detailed }: { signins: FamilySignin[]; detailed: boolean }) {
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>Who can sign in to the portal for this QuickBooks customer, and why someone can&apos;t.</p>
      {signins.length === 0 ? <Notice tone="info" live="none">Nobody can sign in for it yet.</Notice> : (
        <DataTable caption="Each person, and whether they can sign in" captionHidden rows={signins}
          rowKey={(s) => `${s.parentId ?? "none"}|${s.sourceQboId ?? "none"}|${s.email ?? ""}`} columns={[
            { key: "name", header: "Person", rowHeader: true, cell: (s) => (detailed && s.parentId ? <Link href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : s.name) },
            { key: "email", header: "Email", cell: (s) => s.email ?? "No email address" },
            { key: "words", header: "Sign-in", cell: (s) => s.words },
          ]} />
      )}
    </section>
  );
}

/**
 * The family's other staff pages, each for staff who may open it: the way from the roster to a family's money, its
 * season, its volunteering and its buy-outs, without going back to a list. Each of those pages records its own read.
 */
function Elsewhere({ familyId, money, season, credit, buyouts }: { familyId: AppFamilyId; money: boolean; season: boolean; credit: boolean; buyouts: boolean }) {
  if (!money && !season && !credit && !buyouts) return null;
  return (
    <section className="box" aria-labelledby="entry-elsewhere-h"><h2 id="entry-elsewhere-h">More about this family</h2>
      <ul className="lines">
        {money && <li><Link className="link-line" href={familyBalancePage(familyId)}>What it owes</Link></li>}
        {season && <li><Link className="link-line" href={familyProgressPage(familyId)}>Where it stands this season</Link></li>}
        {credit && <li><Link className="link-line" href={familyCreditPage(familyId)}>Its volunteering credit</Link></li>}
        {buyouts && <li><Link className="link-line" href={familyBuyoutsPage(familyId)}>Its volunteer buy-outs</Link></li>}
      </ul>
    </section>
  );
}

export default async function RosterEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const { id } = await params;
  // The app's own family id (stage 3 of the app-owned families spec): anything that isn't a family record's answers 404.
  const familyId = await familyRecordAt(id);
  if (!familyId) notFound();
  // The tag first: the roster the page then shows is that company's or a later one, never an earlier one.
  const rosterTag = await currentRosterTag();
  const page = await loadRosterPage(); // one load, so the entry and the freshness notes describe the same snapshot
  // The family's customer, once, through its record's own link: what the roster cache, the sign-ins and the forms below are keyed by.
  const entry = await familyEntry(page, familyId);
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  if (!entry) notFound();
  const customer = entry.kind === "family" ? entry.family.customer : entry.member;
  const qboId = customer.qboId;
  // A staff read of family data (spec §5): recorded before anything is shown, naming the app's family.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "family", targetId: String(familyId), ip: ctx.ip });
  const detailed = can(ctx.effective, "Parents.ReadWrite");
  const signins = await familySignins(qboId, { detailed });
  const waiting = await loadOpenWrites({ familyId, showAmounts: can(ctx.effective, "Finance.Balance.Read") });
  // Changes are offered to staff who may make them, while QuickBooks is connected: each form carries the record's version.
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected && page.shape !== null;
  const records = entry.kind === "family" ? [entry.family.customer, ...entry.family.students, ...entry.family.parents] : [entry.member];
  const edit = canChange ? { rosterTag, versions: await versionsOf(records.map((r) => r.qboId)),
    blocked: new Set(waiting.map((w) => (w.write.op === "create" || !("qboId" in w.write) ? null : w.write.qboId)).filter((x): x is string => x !== null)) } : null;
  // Who making the family inactive covers: everyone active under it in the cache, at any depth, with their versions.
  const cover = edit && entry.kind === "family" ? await familyCover(qboId) : null;
  const families = page.roster?.kind === "layered" ? page.roster.families.filter((f) => f.customer.active).map((f) => ({ qboId: f.customer.qboId, name: f.customer.displayName })) : [];
  return (
    <main className="wrap single">
      <h1 className="page-title">{customer.displayName}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"} as QuickBooks lists it{customer.active ? "" : ". It is inactive in QuickBooks"}. <Link href="/staff/roster">Back to the roster</Link></p>
      <DisconnectedNotice page={page} admin={admin} />
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" noun="Student" people={entry.family.students} contact={false} empty="QuickBooks lists no students under this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" noun="Parent" people={entry.family.parents} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" noun="Member" people={[entry.member]} contact empty="" />
      )}
      {/* Buy-outs for any family or member, active or not: one made inactive may still have one to close. */}
      <Elsewhere familyId={familyId} buyouts
        money={entry.kind === "family" && customer.active && can(ctx.effective, "Finance.Balance.Read")}
        season={entry.kind === "family" && customer.active && can(ctx.effective, "Season.Progress.Read")}
        credit={entry.kind === "family" && customer.active && can(ctx.effective, "Volunteer.Credit.ReadWrite")} />
      <Waiting items={waiting} />
      {edit && entry.kind === "family" && page.shape?.kind === "layered" && <FamilyChanges shape={page.shape} family={entry.family} families={families} edit={edit} cover={cover} />}
      {edit && entry.kind === "member" && <MemberChanges member={entry.member} edit={edit} />}
      {page.shape && <WhatChanges shape={page.shape} canChange={canChange} />}
      <SignIns signins={signins} detailed={detailed} />
      <Freshness page={page} admin={admin} />
    </main>
  );
}
