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
import { AddGuardianForm } from "@/app/staff/(app)/parents/forms";
import { GuardianChange } from "@/app/staff/(app)/parents/guardian-change";
import { addGuardianAction } from "@/app/staff/(app)/parents/actions";
import { DisconnectedNotice, Freshness } from "../freshness";
import { FamilyChanges, MemberChanges, Waiting, WhatChanges } from "../changes";
import type { Cust, Family } from "@/lib/roster/model";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { familyBalancePage, familyBuyoutsPage, familyCreditPage, familyProgressPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

/** A customer's own standing in QuickBooks, or that there is none for a record. */
const standing = (c: Cust | null) => (c === null ? "No customer" : c.active ? "Active" : "Inactive");

/** One row of a people table: a record's name (a student's) or a customer's (a parent's, a member's), with what QuickBooks holds for them. */
type Person = { key: string; name: string; customer: Cust | null };
const ofCustomer = (c: Cust): Person => ({ key: c.qboId, name: c.displayName, customer: c });

/**
 * The people under the family (or the member alone), as a table: a name per row, then what QuickBooks holds for them.
 * Names, emails and phones are QuickBooks text, shown as text only.
 */
function People({ id, title, noun, people, contact, empty }: { id: string; title: string; noun: string; people: Person[]; contact: boolean; empty: string }) {
  const columns: Column<Person>[] = [
    { key: "name", header: noun, rowHeader: true, cell: (p) => p.name },
    ...(contact ? [
      { key: "email", header: "Email", cell: (p: Person) => p.customer?.email ?? "No email address" },
      { key: "phone", header: "Phone", cell: (p: Person) => p.customer?.phone ?? "No phone number" },
    ] : []),
    { key: "status", header: "In QuickBooks", cell: (p) => standing(p.customer) },
  ];
  return (
    <section className="box" aria-labelledby={id}><h2 id={id}>{title}</h2>
      {people.length === 0 ? <Notice tone="info" live="none">{empty}</Notice>
        : <DataTable caption={title} captionHidden columns={columns} rows={people} rowKey={(p) => p.key} />}
    </section>
  );
}

/**
 * `detailed` is for staff with `Parents.ReadWrite`: only they get links to people, and the ways to remove, reinstate
 * and add a guardian (stage 3's slice 7b, in the portal only). `addable` says why a guardian can't be added now, or null
 * when one can: the action checks it again, under the roster lock.
 */
function SignIns({ familyId, signins, detailed, addable }: { familyId: AppFamilyId; signins: FamilySignin[]; detailed: boolean; addable: string | null }) {
  const columns: Column<FamilySignin>[] = [
    { key: "name", header: "Person", rowHeader: true, cell: (s) => (detailed ? <Link href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : s.name) },
    { key: "email", header: "Email", cell: (s) => s.email },
    { key: "words", header: "Sign-in", cell: (s) => s.words },
    ...(detailed ? [{ key: "change", header: "Change", quiet: true, cell: (s: FamilySignin) => <GuardianChange name={s.name} guardianId={s.guardianId} open={s.open} reinstatable={s.reinstatable} /> }] : []),
  ];
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>The family&apos;s guardians in the portal, and whether each can sign in.</p>
      {signins.length === 0 ? <Notice tone="info" live="none">Nobody can sign in for it yet.</Notice> : (
        <DataTable caption="Each person, and whether they can sign in" captionHidden rows={signins} rowKey={(s) => s.guardianId} columns={columns} />
      )}
      {detailed && (
        <>
          <h3>Add a guardian</h3>
          {addable !== null ? <Notice tone="info" live="none">{addable}</Notice> : (
            <>
              <p>They sign in with this address and a code. Someone who already signs in with it for another family is the same person: they are added here too, under the name they have.</p>
              <AddGuardianForm act={addGuardianAction.bind(null, String(familyId))} />
            </>
          )}
        </>
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
  // The family as the app keeps it, with its students, and what QuickBooks holds for its customer from that same roster.
  const entry = await familyEntry(page, familyId);
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  if (!entry) notFound();
  const fam = entry.family, customer = fam.customer;
  // A staff read of family data (spec §5): recorded before anything is shown, naming the app's family.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "family", targetId: String(familyId), ip: ctx.ip });
  const detailed = can(ctx.effective, "Parents.ReadWrite");
  const signins = await familySignins(familyId);
  const waiting = await loadOpenWrites({ familyId, showAmounts: can(ctx.effective, "Finance.Balance.Read") });
  // Changes are offered to staff who may make them, while QuickBooks is connected: each form carries the record's
  // version and sends QuickBooks ids, so a family the roster lists no customer for is offered none.
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected && page.shape !== null;
  const inQuickBooks: Family | null = customer === null ? null
    : { customer, students: fam.students.flatMap((s) => (s.customer ? [s.customer] : [])), parents: fam.parents };
  const records = inQuickBooks ? [inQuickBooks.customer, ...inQuickBooks.students, ...inQuickBooks.parents] : [];
  const edit = canChange && inQuickBooks ? { rosterTag, versions: await versionsOf(records.map((r) => r.qboId)),
    blocked: new Set(waiting.map((w) => (w.write.op === "create" || !("qboId" in w.write) ? null : w.write.qboId)).filter((x): x is string => x !== null)) } : null;
  // Who making the family inactive covers: everyone active under it in the cache, at any depth, with their versions.
  const cover = edit && inQuickBooks && entry.kind === "family" ? await familyCover(inQuickBooks.customer.qboId) : null;
  const families = page.roster?.kind === "layered" ? page.roster.families.filter((f) => f.customer.active).map((f) => ({ qboId: f.customer.qboId, name: f.customer.displayName })) : [];
  return (
    <main className="wrap single">
      <h1 className="page-title">{fam.name}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"}{customer ? <> as QuickBooks lists it{customer.active ? "" : ". It is inactive in QuickBooks"}</> : " the portal keeps, with no customer in QuickBooks"}. <Link href="/staff/roster">Back to the roster</Link></p>
      <DisconnectedNotice page={page} admin={admin} />
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" noun="Student" people={fam.students.map((s) => ({ key: String(s.id), name: s.name, customer: s.customer }))} contact={false} empty="QuickBooks lists no students under this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" noun="Parent" people={fam.parents.map(ofCustomer)} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" noun="Member" people={customer ? [ofCustomer(customer)] : []} contact empty="QuickBooks lists no customer for this member." />
      )}
      {/* Buy-outs for any family or member, active or not: one made inactive may still have one to close. */}
      <Elsewhere familyId={familyId} buyouts
        money={entry.kind === "family" && fam.active && can(ctx.effective, "Finance.Balance.Read")}
        season={entry.kind === "family" && fam.active && can(ctx.effective, "Season.Progress.Read")}
        credit={entry.kind === "family" && fam.active && can(ctx.effective, "Volunteer.Credit.ReadWrite")} />
      <Waiting items={waiting} />
      {edit && inQuickBooks && entry.kind === "family" && page.shape?.kind === "layered" && <FamilyChanges shape={page.shape} family={inQuickBooks} families={families} edit={edit} cover={cover} />}
      {edit && inQuickBooks && entry.kind === "member" && <MemberChanges member={inQuickBooks.customer} edit={edit} />}
      {page.shape && <WhatChanges shape={page.shape} canChange={canChange} />}
      <SignIns familyId={familyId} signins={signins} detailed={detailed}
        addable={!fam.active ? "This family is inactive in the portal, so nobody can be added to it." : customer === null ? "This family has no customer in QuickBooks linked to it, so a guardian can't be added to it yet." : null} />
      <Freshness page={page} admin={admin} />
    </main>
  );
}
