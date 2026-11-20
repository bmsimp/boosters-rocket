// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadRosterPage, familyEntry, type RecordStudent } from "@/lib/roster/queries";
import { familyRecordAt } from "@/lib/families/address";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyCover, guardianCustomers, guardianStandings, moveTargets, studentsBeingMade, versionsOf } from "@/lib/roster/writes";
import { loadOpenWrites } from "@/lib/roster/queue";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { familySignins, type FamilySignin } from "@/lib/parents/directory";
import { AddGuardianForm } from "@/app/staff/(app)/parents/forms";
import { GuardianChange } from "@/app/staff/(app)/parents/guardian-change";
import { addGuardianAction } from "@/app/staff/(app)/parents/actions";
import { DisconnectedNotice, Freshness } from "../freshness";
import { CreateInQuickBooks, FamilyChanges, MemberChanges, MoveStudents, PortalChanges, Waiting, WhatChanges, type MovableStudent } from "../changes";
import { moveAction } from "../write-actions";
import { offers } from "@/lib/roster/operations";
import { placeWords } from "@/lib/roster/place";
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
 * QuickBooks has elsewhere (since stage 3's slice 9c the two can disagree), where that is, in the words the accounting
 * links screen says it in too (placeWords(), src/lib/roster/place.ts): under another family, under no customer, under
 * one that is no family here, no longer a student customer, or gone. QuickBooks text, as text.
 */
const studentStanding = (s: RecordStudent) => (s.customer ? standing(s.customer) : s.place ? placeWords(s.place)
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
      // QuickBooks' own copy, from the roster cache: since stage 3's slice 11a the phone a parent sees and changes is the portal's.
      { key: "phone", header: "Phone in QuickBooks", cell: (p: Person) => p.customer?.phone ?? "No phone number" },
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
function SignIns({ familyId, signins, links, changes, addable, inQuickBooks }: { familyId: AppFamilyId; signins: FamilySignin[]; links: boolean; changes: boolean; addable: string | null;
  inQuickBooks: Map<string, string> }) {
  const columns: Column<FamilySignin>[] = [
    { key: "name", header: "Person", rowHeader: true, cell: (s) => (links ? <Link href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : s.name) },
    { key: "email", header: "Email", cell: (s) => s.email },
    { key: "words", header: "Sign-in", cell: (s) => s.words },
    // Where QuickBooks stands for the guardian's own Parent customer (stage 3's slice 9h), in words.
    { key: "quickbooks", header: "In QuickBooks", cell: (s) => inQuickBooks.get(s.guardianId) ?? "Nothing in QuickBooks for this membership." },
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
              <p>They sign in with this address and a code. If the address already belongs to someone in the portal, you are shown who it is and asked whether this is the same person before anything changes: one address is one person, who may be a guardian of several families. Where the club&apos;s books have parents of their own and this family is linked, the guardian then gets their own Parent customer under the family in QuickBooks, with their name and this address, unless QuickBooks already has a customer of that name here.</p>
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
  const signinStandings = await guardianStandings(signins.map((s) => ({ guardianId: s.guardianId, familyId, name: s.name, open: s.open })));
  // The Parent customers a portal guardian is linked to (stage 3's slice 9h): shown as theirs, with no forms here.
  const ofGuardians = await guardianCustomers(fam.parents.map((p) => p.qboId), familyId);
  const waiting = await loadOpenWrites({ familyId, showAmounts: can(ctx.effective, "Finance.Balance.Read") });
  // Changes are offered to staff who may make them, while QuickBooks is connected: a linked record's rename and
  // make-inactive send its kind and the app's id, the family action the family's app id and a stamp of whom it covers,
  // and only a Parent customer's forms carry a version and a QuickBooks id (stage 3's slice 9g); a family the roster
  // lists no customer for is offered none, nor is a family whose own record is inactive in the portal (the actions
  // refuse one too).
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite") && page.connected && page.shape !== null && fam.active;
  // The family's own create waiting or stuck on the queue (stage 3's slice 9d): nothing else is changed on it meanwhile.
  // A change QuickBooks refused that the portal kept (stage 3's slice 9e) is listed, and blocks nothing.
  const open = waiting.filter((w) => w.state !== "refused");
  const making = !fam.linked && open.some((w) => w.write.op === "create" && (w.write.role === "family" || w.write.role === "member"));
  // A family with no link, and students with none, are changed in the portal only, connected or not (stage 3's slice 9d),
  // on a roster of the portal's company (changeInPortal() refuses one whose cache names none).
  const changesHere = can(ctx.effective, "Roster.Family.ReadWrite") && page.shape !== null && fam.active && !making && rosterTag !== "none";
  // A student whose own create is waiting or stuck on the queue is changed nowhere meanwhile, and not made again.
  const beingMade = await studentsBeingMade(fam.students.filter((s) => s.active).map((s) => s.id));
  const hereStudents = fam.students.filter((s) => s.active && !s.linked && !beingMade.has(String(s.id)));
  const studentType = page.shape?.kind === "layered" && page.shape.studentTypeId !== null;
  // "Create in QuickBooks and link": for an active family with no link, or with active students with none (where the
  // books have a student type) under a customer QuickBooks holds as an active family, to staff who may change families
  // and link them to accounting (createInQuickBooksAndLink() refuses one under an inactive customer).
  const toMake = !fam.linked || (studentType && hereStudents.length > 0 && customer !== null && customer.active);
  const inQuickBooks: Family | null = customer === null ? null
    : { customer, students: fam.students.flatMap((s) => (s.customer ? [s.customer] : [])), parents: fam.parents };
  // Students whose record is inactive are offered nothing that would send. One QuickBooks has under another family is
  // moved like any other (stage 3's slice 9f): the page says where QuickBooks has them (studentStanding()).
  const inactiveRecords = new Set(fam.students.flatMap((s) => (!s.active && s.customer ? [s.customer.qboId] : [])));
  const records = inQuickBooks ? [inQuickBooks.customer, ...inQuickBooks.students, ...inQuickBooks.parents] : [];
  // Each linked record by its customer, for the renames saved in the portal first (by the app's id, from the portal's own name).
  const linkedRecords = new Map<string, { kind: "family" | "student"; id: string; name: string }>(inQuickBooks ? [
    [inQuickBooks.customer.qboId, { kind: "family", id: String(familyId), name: fam.name }],
    ...fam.students.flatMap((s): [string, { kind: "student"; id: string; name: string }][] => (s.customer ? [[s.customer.qboId, { kind: "student", id: String(s.id), name: s.name }]] : [])),
  ] : []);
  const edit = canChange && inQuickBooks ? { rosterTag, versions: await versionsOf(records.map((r) => r.qboId)), familyId: String(familyId), records: linkedRecords,
    guardianCustomers: ofGuardians,
    blocked: new Set(open.map((w) => (w.write.op === "create" || !("qboId" in w.write) ? null : w.write.qboId)).filter((x): x is string => x !== null)),
    // A student with a move QuickBooks refused that the portal kept (slice 9f) isn't made inactive until it is sent or
    // given up (deactivateLinked() refuses it): their make-inactive is not offered, and the page says why.
    keptMoves: new Set(fam.students.flatMap((s) => (s.customer !== null && waiting.some((w) => w.state === "refused" && w.write.op === "move" && w.studentId !== null
      && String(w.studentId) === String(s.id)) ? [s.customer.qboId] : []))) } : null;
  // Who making the family inactive covers: everyone active under it in the cache, at any depth, sealed into the form's
  // action as a stamp (coverStamp()), never as ids or versions the browser sends back.
  const cover = edit && inQuickBooks && entry.kind === "family" ? await familyCover(inQuickBooks.customer.qboId) : null;
  // Moving a student (stage 3's slice 9f): saved in the portal first, for each active student of the family, linked or
  // not, to each of the portal's other active families, linked or not, by the app's ids: only the families a move can go
  // to, by the rule moveStudent() checks (moveTargets()), and none while a move out of this family can't go through. Not
  // while the family's own create waits, nor for a student whose own create, or another change, waits (moveStudent()
  // refuses them too).
  const moves = changesHere && page.shape !== null && entry.kind === "family" && offers(page.shape, "move_student");
  const moveTo = moves ? await moveTargets(familyId) : { refusedHere: null, families: [] };
  const movable: MovableStudent[] = moves ? fam.students.filter((s) => s.active).map((s) => ({ id: String(s.id), name: s.name,
    blocked: beingMade.has(String(s.id)) ? "Making this student in QuickBooks is still waiting on the queue, so they can't be moved for now."
      : open.some((w) => w.studentId !== null && String(w.studentId) === String(s.id)) || (s.customer !== null && open.some((w) => "qboId" in w.write && w.write.qboId === s.customer!.qboId))
        ? `A change to ${s.name} is waiting to reach QuickBooks, so they can't be moved until it has gone through, or been given up on the Reconciliation page.` : null })) : [];
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
          <People id="entry-parents-h" title="Parents in QuickBooks" noun="Parent" contact empty="QuickBooks lists no parents under this family."
            people={fam.parents.map((c) => ({ ...ofCustomer(c), standing: `${standing(c)}: ${ofGuardians.get(c.qboId) === "own" ? "a portal guardian's own, changed through them under Portal sign-ins and on their page"
              : ofGuardians.get(c.qboId) === "other" ? "linked to a portal guardian, but not one guardian's own under this family (several share it, or theirs is another family), so the portal sends nothing for it: change it in QuickBooks, and the mapping screen will sort it out"
              : ofGuardians.get(c.qboId) === "removed" ? "the own Parent customer of a guardian removed from this family, left active in QuickBooks (a removal makes it inactive only when its balance allows): adding them back under Portal sign-ins uses it again"
              : "not a portal guardian; adding the person under Portal sign-ins doesn't use it, and the mapping screen will offer to link it"}` }))} />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" noun="Member" people={customer ? [ofCustomer(customer)] : []} contact empty="QuickBooks lists no customer for this member." />
      )}
      {/* Buy-outs for any linked family or member, active or not: one made inactive may still have one to close. A family
          with no link has none (a buy-out bills its linked customer) and its buy-outs page answers 404, so it gets no link
          (stage 3's slice 9d). What it owes only for a family linked to an active family customer: its page stands for no
          other (loadFamilyBalance()). */}
      <Elsewhere familyId={familyId} buyouts={fam.linked}
        money={entry.kind === "family" && fam.active && customer !== null && customer.active && can(ctx.effective, "Finance.Balance.Read")}
        season={entry.kind === "family" && fam.active && can(ctx.effective, "Season.Progress.Read")}
        credit={entry.kind === "family" && fam.active && can(ctx.effective, "Volunteer.Credit.ReadWrite")} />
      <Waiting items={waiting} />
      {edit && inQuickBooks && entry.kind === "family" && page.shape?.kind === "layered" && <FamilyChanges shape={page.shape} family={inQuickBooks} edit={edit} cover={cover} inactiveRecords={inactiveRecords} />}
      {moves && <MoveStudents students={movable} families={moveTo.families} refusedHere={moveTo.refusedHere} rosterTag={rosterTag} act={moveAction} />}
      {edit && inQuickBooks && entry.kind === "member" && <MemberChanges member={inQuickBooks.customer} edit={edit} />}
      {changesHere && page.shape && <PortalChanges familyId={String(familyId)} name={fam.name} noun={entry.kind} unlinked={!fam.linked}
        addStudents={offers(page.shape, "add_student")} students={hereStudents.map((s) => ({ id: String(s.id), name: s.name }))} rosterTag={rosterTag} />}
      {changesHere && toMake && <CreateInQuickBooks familyId={String(familyId)} name={fam.name} noun={entry.kind} unlinked={!fam.linked}
        students={studentType ? hereStudents.map((s) => s.name) : []} rosterTag={rosterTag} ready={page.connected && page.roster !== null}
        may={can(ctx.effective, "Accounting.Link.ReadWrite")}
        types={page.shape?.kind === "flat" ? page.shape.memberTypeIds.map((t) => ({ qboId: t, name: page.types.find((x) => x.qboId === t)?.name ?? "A member type" })) : []} />}
      {page.shape && <WhatChanges shape={page.shape} canChange={canChange} unlinked={!fam.linked} />}
      <SignIns familyId={familyId} signins={signins} links={links} changes={changesGuardians} inQuickBooks={signinStandings}
        addable={!fam.active ? "This family is inactive in the portal, so nobody can be added to it."
          : making ? "Making this family in QuickBooks is still waiting on the queue, so nobody can be added to it for now." : null} />
      <Freshness page={page} admin={admin} />
    </main>
  );
}
