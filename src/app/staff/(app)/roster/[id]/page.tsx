// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadRosterPage, familyEntry, rosterFamilies, type RecordStudent } from "@/lib/roster/queries";
import { familyRecordAt } from "@/lib/families/address";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyCover, studentsBeingMade, versionsOf } from "@/lib/roster/writes";
import { loadOpenWrites } from "@/lib/roster/queue";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { familySignins, type FamilySignin } from "@/lib/parents/directory";
import { AddGuardianForm } from "@/app/staff/(app)/parents/forms";
import { GuardianChange } from "@/app/staff/(app)/parents/guardian-change";
import { addGuardianAction } from "@/app/staff/(app)/parents/actions";
import { DisconnectedNotice, Freshness } from "../freshness";
import { CreateInQuickBooks, FamilyChanges, MemberChanges, PortalChanges, Waiting, WhatChanges } from "../changes";
import { offers } from "@/lib/roster/operations";
import type { Cust, Family } from "@/lib/roster/model";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { familyBalancePage, familyBuyoutsPage, familyCreditPage, familyProgressPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

/** A customer's own standing in QuickBooks, or that there is none for a record. */
const standing = (c: Cust | null) => (c === null ? "No customer" : c.active ? "Active" : "Inactive");
/**
 * A student record's standing in QuickBooks: its customer's under this family; or, for a record whose linked customer
 * QuickBooks lists elsewhere (since stage 3's slice 9c the two can disagree), where that is. QuickBooks text, as text.
 */
const studentStanding = (s: RecordStudent) => (s.customer ? standing(s.customer) : s.elsewhere ? `Under ${s.elsewhere.familyName} in QuickBooks`
  : s.linked ? "Not under a family in QuickBooks" : "No customer");

/** One row of a people table: a record's name (a student's) or a customer's (a parent's, a member's), with what QuickBooks holds for them. */
type Person = { key: string; name: string; customer: Cust | null; standing?: string };
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
    { key: "status", header: "In QuickBooks", cell: (p) => p.standing ?? standing(p.customer) },
  ];
  return (
    <section className="box" aria-labelledby={id}><h2 id={id}>{title}</h2>
      {people.length === 0 ? <Notice tone="info" live="none">{empty}</Notice>
        : <DataTable caption={title} captionHidden columns={columns} rows={people} rowKey={(p) => p.key} />}
    </section>
  );
}

/**
 * `links` is for staff with `Parents.ReadWrite`, who may open a person's page. `changes` is for staff with
 * `Roster.Family.ReadWrite`, who change the family: only they get the ways to remove, reinstate and add a guardian
 * (stage 3's slice 7b, in the portal only), which give or end an address's sign-in for it. `addable` says why a
 * guardian can't be added now, or null when one can: the action checks it again, under the roster lock. A family with
 * no link takes guardians too (stage 3's slice 9d).
 */
function SignIns({ familyId, signins, links, changes, addable }: { familyId: AppFamilyId; signins: FamilySignin[]; links: boolean; changes: boolean; addable: string | null }) {
  const columns: Column<FamilySignin>[] = [
    { key: "name", header: "Person", rowHeader: true, cell: (s) => (links ? <Link href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : s.name) },
    { key: "email", header: "Email", cell: (s) => s.email },
    { key: "words", header: "Sign-in", cell: (s) => s.words },
    ...(changes ? [{ key: "change", header: "Change", quiet: true, cell: (s: FamilySignin) => <GuardianChange name={s.name} guardianId={s.guardianId} open={s.open} reinstatable={s.reinstatable} /> }] : []),
  ];
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>The family&apos;s guardians in the portal, and whether each can sign in.</p>
      {signins.length === 0 ? <Notice tone="info" live="none">Nobody can sign in for it yet.</Notice> : (
        <DataTable caption="Each person, and whether they can sign in" captionHidden rows={signins} rowKey={(s) => s.guardianId} columns={columns} />
      )}
      {changes && (
        <>
          <h3>Add a guardian</h3>
          {addable !== null ? <Notice tone="info" live="none">{addable}</Notice> : (
            <>
              <p>They sign in with this address and a code. If the address already belongs to someone in the portal, you are shown who it is and asked whether this is the same person before anything changes: one address is one person, who may be a guardian of several families.</p>
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
  const links = can(ctx.effective, "Parents.ReadWrite");
  const changesGuardians = can(ctx.effective, "Roster.Family.ReadWrite");
  const signins = await familySignins(familyId);
  const waiting = await loadOpenWrites({ familyId, showAmounts: can(ctx.effective, "Finance.Balance.Read") });
  // Changes are offered to staff who may make them, while QuickBooks is connected: each form carries the record's
  // version and sends QuickBooks ids, so a family the roster lists no customer for is offered none; nor is a family
  // whose own record is inactive in the portal (the action refuses one too, prepare() in src/lib/roster/writes.ts).
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected && page.shape !== null && fam.active;
  // The family's own create waiting or stuck on the queue (stage 3's slice 9d): nothing else is changed on it meanwhile.
  const making = !fam.linked && waiting.some((w) => w.write.op === "create" && (w.write.role === "family" || w.write.role === "member"));
  // A family with no link, and students with none, are changed in the portal only, connected or not (stage 3's slice 9d),
  // on a roster of the portal's company (changeInPortal() refuses one whose cache names none).
  const changesHere = can(ctx.effective, "Roster.Family.ReadWrite") && page.shape !== null && fam.active && !making && rosterTag !== "none";
  // A student whose own create is waiting or stuck on the queue is changed nowhere meanwhile, and not made again.
  const beingMade = await studentsBeingMade(fam.students.filter((s) => s.active && !s.linked).map((s) => s.id));
  const hereStudents = fam.students.filter((s) => s.active && !s.linked && !beingMade.has(String(s.id)));
  const studentType = page.shape?.kind === "layered" && page.shape.studentTypeId !== null;
  // "Create in QuickBooks and link": for an active family with no link, or with active students with none (where the
  // books have a student type) under a customer QuickBooks holds as an active family, to staff who may change families
  // and link them to accounting (createInQuickBooksAndLink() refuses one under an inactive customer).
  const toMake = !fam.linked || (studentType && hereStudents.length > 0 && customer !== null && customer.active);
  const inQuickBooks: Family | null = customer === null ? null
    : { customer, students: fam.students.flatMap((s) => (s.customer ? [s.customer] : [])), parents: fam.parents };
  // Students whose record is inactive are offered nothing that would send; one QuickBooks has under another family is
  // offered the move there, which sends nothing and brings the record into line.
  const inactiveRecords = new Set(fam.students.flatMap((s) => (!s.active && s.customer ? [s.customer.qboId] : [])));
  const elsewhere = fam.students.flatMap((s) => (s.active && s.elsewhere ? [{ name: s.name, ...s.elsewhere }] : []));
  const records = inQuickBooks ? [inQuickBooks.customer, ...inQuickBooks.students, ...inQuickBooks.parents, ...elsewhere.map((s) => s.customer)] : [];
  const edit = canChange && inQuickBooks ? { rosterTag, versions: await versionsOf(records.map((r) => r.qboId)),
    blocked: new Set(waiting.map((w) => (w.write.op === "create" || !("qboId" in w.write) ? null : w.write.qboId)).filter((x): x is string => x !== null)) } : null;
  // Who making the family inactive covers: everyone active under it in the cache, at any depth, with their versions.
  const cover = edit && inQuickBooks && entry.kind === "family" ? await familyCover(inQuickBooks.customer.qboId) : null;
  // Where a student may be moved: the app's own active families whose customer is an active family on the roster, by the
  // record's name. A family customer added in QuickBooks alone has no record since stage 3's slice 9c, and is not offered
  // (the move refuses it too, prepare() in src/lib/roster/writes.ts).
  const families = edit && page.roster?.kind === "layered" ? ((await rosterFamilies(page)) ?? [])
    .flatMap((f) => (f.active && f.customer?.active ? [{ qboId: f.customer.qboId, name: f.name }] : [])) : [];
  return (
    <main className="wrap single">
      <h1 className="page-title">{fam.name}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"} the portal keeps{customer ? <>, linked to its customer in QuickBooks{customer.active ? "" : ", which is inactive there"}</>
        : fam.linked ? `, linked to a customer QuickBooks doesn't list as a ${entry.kind} now`
        : making ? ", not linked to QuickBooks yet: its customer is being made there" : ", not linked to QuickBooks: it is in the portal only, and a change to it is saved here only"}. <Link href="/staff/roster">Back to the roster</Link></p>
      <DisconnectedNotice page={page} admin={admin} />
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" noun="Student" people={fam.students.map((s) => ({ key: String(s.id), name: s.name, customer: s.customer, standing: studentStanding(s) }))} contact={false} empty="The portal holds no students for this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" noun="Parent" people={fam.parents.map(ofCustomer)} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" noun="Member" people={customer ? [ofCustomer(customer)] : []} contact empty="QuickBooks lists no customer for this member." />
      )}
      {/* Buy-outs for any family or member, active or not: one made inactive may still have one to close. What it owes
          only for a family linked to an active family customer: its page stands for no other (loadFamilyBalance()). */}
      <Elsewhere familyId={familyId} buyouts
        money={entry.kind === "family" && fam.active && customer !== null && customer.active && can(ctx.effective, "Finance.Balance.Read")}
        season={entry.kind === "family" && fam.active && can(ctx.effective, "Season.Progress.Read")}
        credit={entry.kind === "family" && fam.active && can(ctx.effective, "Volunteer.Credit.ReadWrite")} />
      <Waiting items={waiting} />
      {edit && inQuickBooks && entry.kind === "family" && page.shape?.kind === "layered" && <FamilyChanges shape={page.shape} family={inQuickBooks} families={families} edit={edit} cover={cover} inactiveRecords={inactiveRecords} elsewhere={elsewhere} />}
      {edit && inQuickBooks && entry.kind === "member" && <MemberChanges member={inQuickBooks.customer} edit={edit} />}
      {changesHere && page.shape && <PortalChanges familyId={String(familyId)} name={fam.name} noun={entry.kind} unlinked={!fam.linked}
        addStudents={offers(page.shape, "add_student")} students={hereStudents.map((s) => ({ id: String(s.id), name: s.name }))} rosterTag={rosterTag} />}
      {changesHere && toMake && <CreateInQuickBooks familyId={String(familyId)} name={fam.name} noun={entry.kind} unlinked={!fam.linked}
        students={studentType ? hereStudents.map((s) => s.name) : []} rosterTag={rosterTag} ready={page.connected && page.roster !== null}
        may={can(ctx.effective, "Accounting.Link.ReadWrite")}
        types={page.shape?.kind === "flat" ? page.shape.memberTypeIds.map((t) => ({ qboId: t, name: page.types.find((x) => x.qboId === t)?.name ?? "A member type" })) : []} />}
      {page.shape && <WhatChanges shape={page.shape} canChange={canChange} unlinked={!fam.linked} />}
      <SignIns familyId={familyId} signins={signins} links={links} changes={changesGuardians}
        addable={!fam.active ? "This family is inactive in the portal, so nobody can be added to it."
          : making ? "Making this family in QuickBooks is still waiting on the queue, so nobody can be added to it for now." : null} />
      <Freshness page={page} admin={admin} />
    </main>
  );
}
