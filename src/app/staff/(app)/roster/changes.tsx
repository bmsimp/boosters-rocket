import type { ReactNode } from "react";
import type { MembershipShape } from "@/lib/roster/shape";
import type { Cust, Family } from "@/lib/roster/model";
import { NOT_HERE, shapeOperations, type RosterOperation } from "@/lib/roster/operations";
import { waitingWords, type QueueView } from "@/lib/roster/queue";
import { coverStamp, keptWordsFor } from "@/lib/roster/writes";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { DataTable } from "@/app/components/data-table";
import type { Covered } from "@/lib/roster/writes";
import { CreateAndLinkForm, DeactivateForm, FamilyInactiveForm, MemberForm, MoveForm, NameForm } from "./write-forms";
import type { WriteResult } from "@/lib/roster/writes";
import { addStudentAction, addStudentHereAction, createAction, createAndLinkAction, deactivateAction, deactivateHereAction, deactivateLinkedAction, familyInactiveAction,
  renameHereAction, renameLinkedAction, renameParentAction } from "./write-actions";

/**
 * The roster's changes in QuickBooks, for staff who hold Roster.Family.ReadWrite with Roster.Read. Every form's action
 * has the page's roster tag and the record's id bound in: a rename of a linked family, member or student, a new
 * student and a move of a student, the app's ids (saved in the portal first, stage 3's slices 9e and 9f, and sent with
 * the link's own version); a linked student's or member's make-inactive, the app's id too (QuickBooks first, sent with
 * the link's own version, stage 3's slice 9g), and the family's, the family record's app id and a stamp of whom the page
 * covered; a Parent customer's changes, the customer's id and the version the page was shown, only for one no portal
 * guardian is linked to (stage 3's slice 9h: a guardian's own Parent customer is changed through the guardian). Names
 * are QuickBooks text, or the portal's own, shown as text only.
 */

/** What can be changed here for this club, and why the rest can't, in words (src/lib/roster/operations.ts). */
export function WhatChanges({ shape, canChange, unlinked = false }: { shape: MembershipShape; canChange: boolean; unlinked?: boolean }) {
  const { offered, notOffered } = shapeOperations(shape);
  const words: [RosterOperation, string][] = shape.kind === "flat"
    ? [["create_member", "make a member"], ["rename_member", "rename one"], ["deactivate_member", "make one inactive"]]
    : [["create_family", "make a family"], ["add_student", "add a student"], ["add_parent", "give each guardian added under Portal sign-ins their own Parent customer in QuickBooks"],
        ["rename_family", "rename a family, student or parent"], ["move_student", "move a student to another family"], ["deactivate_family", "make a family, student or parent inactive"]];
  const can = words.filter(([o]) => offered.has(o)).map(([, w]) => w);
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}` : can[0] ?? "";
  return (
    <section className="box" aria-labelledby="changes-h"><h2 id="changes-h">Changing the roster</h2>
      <p>{canChange ? <>From the portal you can {list}. For a family linked to QuickBooks, a rename, a new student or a move of a student is saved in the portal first and then sent to QuickBooks; if QuickBooks refuses it, the portal keeps it and the Reconciliation page lists it. What follows a move happens at once: a completed form goes with the student and an unfinished one starts again in the new family, their places on shifts still to come are given up and none of their places counts for the family they joined, the credit they earned stays with the family it was earned for, and an unpaid volunteer buy-out invoice of theirs is queued to be voided while a paid one is flagged for the club. Their invoices follow once QuickBooks has the move. Making someone inactive is sent to QuickBooks first, and the roster shows it once QuickBooks has it. A guardian added under Portal sign-ins gets their own Parent customer under the family, with their name and sign-in address, unless QuickBooks already has a customer of that name there; it is renamed with them, and made inactive when they are removed, only when it has no balance the portal can read, owed or a credit.</>
        : <>Staff who may change the roster can {list} from the portal. For a family linked to QuickBooks, a rename, a new student or a move of a student is saved in the portal first; making someone inactive is sent to QuickBooks first.</>}</p>
      <p>{unlinked ? "This family has no customer in QuickBooks: a change to it is saved in the portal only."
        : "A new family is saved in the portal first, and made in QuickBooks too when the staff member who adds it may link families to accounting. A family with no customer in QuickBooks is changed in the portal only."}</p>
      {notOffered.map((n) => <p key={n.why}>{n.why}</p>)}
      <p>{NOT_HERE.contact}</p>
    </section>
  );
}

/**
 * The writes waiting or stuck for this family or member, and the changes saved in the portal first that QuickBooks
 * refused (stage 3's slice 9e), each under its own heading: shown to everyone who can see the page, with no buttons (the
 * Reconciliation page has them). A refused change blocks nothing here, but that a kept move holds back making either of
 * its families inactive (MOVE_PENDING) until it is sent or given up.
 */
export function Waiting({ items }: { items: QueueView[] }) {
  const open = items.filter((i) => i.state !== "refused"), refused = items.filter((i) => i.state === "refused");
  return (
    <>
      {open.length > 0 && (
        <section className="box" aria-labelledby="waiting-h"><h2 id="waiting-h">Waiting to reach QuickBooks</h2>
          <p>These changes were asked for and haven&apos;t been finished yet: most are waiting for QuickBooks to take them. Nothing else can be changed on the same record until they go through or are given up on the <a href="/staff/reconciliation">Reconciliation page</a>, but for a parent&apos;s phone and mailing address, which hold nothing back.</p>
          <DataTable caption="Each change, and where it stands" captionHidden rows={open} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => <>{i.words}{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</> },
            { key: "state", header: "Where it stands", cell: (i) => waitingWords(i) },
            { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
          ]} />
        </section>
      )}
      {refused.length > 0 && (
        <section className="box" aria-labelledby="refused-h"><h2 id="refused-h">Kept in the portal, not in QuickBooks</h2>
          <p>These changes are saved in the portal, but they didn&apos;t go through to QuickBooks (QuickBooks refused them, the portal held them back as QuickBooks has something else, or they couldn&apos;t be sent), so QuickBooks still has something else. They don&apos;t stop other changes, except that a student&apos;s move kept here stops either of its two families being made inactive until it is sent or given up. On the <a href="/staff/reconciliation">Reconciliation page</a>, someone who may change families can send the portal&apos;s value again or give it up.</p>
          <DataTable caption="Each change that didn't go through, and why" captionHidden rows={refused} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => <>{i.words}{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</> },
            { key: "why", header: "Why", cell: (i) => keptWordsFor(i.write, i.lastCode, i.holds, i.differs) },
            { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
          ]} />
        </section>
      )}
    </>
  );
}

/**
 * Where a new family or member goes, said on the add form (stage 3's slice 9d): `sends`, it is made in QuickBooks too
 * and linked (the staff member may link families to accounting, and QuickBooks is connected); `no_permission`, it is in
 * the portal only until someone who may link presses "Create in QuickBooks and link" on its page; `not_connected`, the
 * same until QuickBooks is connected.
 */
export type AddGoesTo = "sends" | "no_permission" | "not_connected";
const addGoesWords = (goes: AddGoesTo, noun: string, type: string) => goes === "sends"
  ? `It is saved in the portal first, then made in QuickBooks as a customer of the ${type} and linked to it.`
  : goes === "no_permission"
    ? `It is saved in the portal only: making its customer in QuickBooks and linking the two takes the permission to link families to accounting. Someone who holds it can press “Create in QuickBooks and link” on the ${noun}'s page.`
    : `It is saved in the portal only, as QuickBooks isn't connected: once it is, someone who may link families to accounting can press “Create in QuickBooks and link” on the ${noun}'s page.`;

/** Making a new family, or a new member, from the roster list: the portal's own record first (stage 3's slice 9d). */
export function CreateBox({ shape, rosterTag, memberTypes, goes }: { shape: MembershipShape; rosterTag: string; memberTypes: { qboId: string; name: string }[]; goes: AddGoesTo }) {
  const pendingLabel = goes === "sends" ? "Saving, then making it in QuickBooks…" : "Saving…";
  if (shape.kind === "flat") {
    return (
      <section className="box" aria-labelledby="create-h"><h2 id="create-h">Make a member</h2>
        <p>{addGoesWords(goes, "member", `member type${memberTypes.length > 1 ? " you choose" : ""}`)} Their email address is added in QuickBooks. Their phone and mailing address are the portal&apos;s own: the member&apos;s guardians set them on their Family page.</p>
        <MemberForm types={goes === "sends" ? memberTypes : []} pendingLabel={pendingLabel} act={createAction.bind(null, rosterTag, "member")} />
      </section>
    );
  }
  return (
    <section className="box" aria-labelledby="create-h"><h2 id="create-h">Make a family</h2>
      <p>{addGoesWords(goes, "family", "family type")} Add its students and guardians from the family&apos;s page once it is saved.</p>
      <NameForm field="The family's name" label="Make the family" pendingLabel={pendingLabel} act={createAction.bind(null, rosterTag, "family")} />
    </section>
  );
}

/** A student of the family's record with no customer in QuickBooks, for the portal's own changes. */
export type HereStudent = { id: string; name: string };

/**
 * A family with no link, and students with none, changed in the portal only (stage 3's slice 9d; app-owned families
 * spec section 5: "A change to an unlinked family stays in the app"): nothing is sent to QuickBooks and there is no
 * balance to check. `unlinked`: the family itself has no link, so it is renamed, made inactive and given students here;
 * otherwise only `students` (active, with no link of their own) are. Offered only to staff who may change families,
 * for an active family whose own create isn't waiting on the queue; the actions check everything again.
 */
export function PortalChanges({ familyId, name, noun, unlinked, addStudents, students, rosterTag }: {
  familyId: string; name: string; noun: "family" | "member"; unlinked: boolean; addStudents: boolean; students: HereStudent[]; rosterTag: string;
}) {
  if (!unlinked && students.length === 0) return null;
  return (
    <section className="box" aria-labelledby="portal-changes-h"><h2 id="portal-changes-h">Change in the portal</h2>
      <p>{unlinked ? `This ${noun} has no customer in QuickBooks, so a change made here is saved in the portal only: nothing is sent to QuickBooks.`
        : "These students have no customer in QuickBooks, so a change to them is saved in the portal only: nothing is sent to QuickBooks."}</p>
      {unlinked && (
        <details className="more"><summary>Change the {noun} {name}</summary>
          <NameForm field="New name" label="Rename" pendingLabel="Renaming…" initial={name} act={renameHereAction.bind(null, rosterTag, "family", familyId)} />
          <DeactivateForm label={`Make ${name} inactive`}
            warning={`This makes ${name} inactive in the portal${noun === "family" ? ", with its students" : ""}: its guardians can no longer sign in to it. It can't be made active again in the portal, and with no customer in QuickBooks its page here goes away; what it holds (its season, forms and volunteering) is kept. Nothing is sent to QuickBooks, and there is no balance to check: it has no customer there.`}
            act={deactivateHereAction.bind(null, rosterTag, "family", familyId)} />
        </details>
      )}
      {unlinked && addStudents && (
        <details className="more"><summary>Add a student</summary>
          <NameForm field="The student's name" label="Add the student" pendingLabel="Adding…" act={addStudentHereAction.bind(null, rosterTag, familyId)} />
        </details>
      )}
      {students.map((s) => (
        <details key={s.id} className="more"><summary>Change the student {s.name}</summary>
          <NameForm field="New name" label="Rename" pendingLabel="Renaming…" initial={s.name} act={renameHereAction.bind(null, rosterTag, "student", s.id)} />
          <DeactivateForm label={`Make ${s.name} inactive`} warning={`${s.name} is no longer counted in the family's season. Nothing is sent to QuickBooks: they have no customer there.`}
            act={deactivateHereAction.bind(null, rosterTag, "student", s.id)} />
        </details>
      ))}
    </section>
  );
}

/**
 * "Create in QuickBooks and link" (stage 3's slice 9d), for an active family with no link or with students with none:
 * what pressing it makes, and the button for staff who may change families and link them to accounting (`may`), while
 * QuickBooks is connected to the roster's company (`ready`). Anyone else who may change families is told who can.
 */
export function CreateInQuickBooks({ familyId, name, noun, unlinked, students, types, rosterTag, may, ready }: {
  familyId: string; name: string; noun: "family" | "member"; unlinked: boolean; students: string[]; types: { qboId: string; name: string }[];
  rosterTag: string; may: boolean; ready: boolean;
}) {
  const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const what = unlinked
    ? `This makes ${name} a customer in QuickBooks${students.length ? `, then ${listed(students)} under it, one by one` : ""}, and links each to its record here. Its invoices then show to its guardians.`
    : `This makes ${listed(students)} customers in QuickBooks under ${name}, one by one, and links each to their record here.`;
  return (
    <section className="box" aria-labelledby="create-link-h"><h2 id="create-link-h">Create in QuickBooks and link</h2>
      <p>{what} If one of them can&apos;t be made, it stops there and says why; pressing again carries on with whatever is still unlinked.</p>
      {!ready ? <Notice tone="info" live="none">QuickBooks isn&apos;t connected to the company this roster was read from, so nothing can be made there just now.</Notice>
        : !may ? <Notice tone="info" live="none">Someone who may link families to accounting can make it in QuickBooks and link it.</Notice>
        : <CreateAndLinkForm types={unlinked && noun === "member" ? types : []} act={createAndLinkAction.bind(null, rosterTag, familyId)} />}
    </section>
  );
}

/**
 * What the forms of a family's page are given: the roster tag, each customer's version (sent only by a Parent
 * customer's rename and make-inactive, which go to QuickBooks first; stage 3's slice 9g), the customers a change waits
 * for, the family record's app id (for a new student and the family action), and each linked record by its customer
 * (`records`: the family's or member's own, and each student's), whose rename is saved in the portal first and whose
 * make-inactive is sent by its kind and app id. `keptMoves`: the customers of students with a move QuickBooks refused
 * that the portal kept, who aren't made inactive until it is sent or given up. `guardianCustomers`: the Parent customers
 * an open guardian row is linked to (stage 3's slice 9h), offered no forms here: `own`, one guardian's own, changed
 * through them; `other`, shared or another family's guardian's, changed in QuickBooks for now.
 */
export type Edit = { rosterTag: string; versions: Map<string, string>; blocked: Set<string>; familyId: string;
  records: Map<string, { kind: "family" | "student"; id: string; name: string }>; keptMoves?: Set<string>; guardianCustomers?: Map<string, "own" | "other" | "removed"> };

/**
 * Rename and make inactive, for one record: offered only when the shape allows it and nothing is waiting for it. Making
 * inactive is offered for a customer QuickBooks has inactive already when the portal's own record of it is still
 * active (`follow`): it sends nothing, and makes the record match.
 */
function RecordChanges({ who, c, rename, deactivate, warning, edit, extra, follow = false }: {
  who: string; c: Cust; rename: boolean; deactivate: boolean; warning: string; edit: Edit; extra?: ReactNode; follow?: boolean;
}) {
  const version = edit.versions.get(c.qboId);
  if (version === undefined) return null;
  // A linked family, member or student: its rename is saved in the portal first (stage 3's slice 9e); a parent's goes to QuickBooks first.
  const record = edit.records.get(c.qboId);
  if (edit.blocked.has(c.qboId)) return <Notice tone="info" live="none">A change to {c.displayName} is waiting to reach QuickBooks, so nothing else can be changed for now.</Notice>;
  return (
    <details className="more"><summary>Change {who} {c.displayName}</summary>
      {rename && (record ? <NameForm field="New name" label="Rename" pendingLabel="Saving in the portal, then sending to QuickBooks…" initial={record.name}
        act={renameLinkedAction.bind(null, edit.rosterTag, record.kind, record.id)} />
        : <NameForm field="New name" label="Rename" pendingLabel="Renaming in QuickBooks…" initial={c.displayName} act={renameParentAction.bind(null, edit.rosterTag, c.qboId, version)} />)}
      {extra}
      {deactivate && record?.kind === "student" && edit.keptMoves?.has(c.qboId) ? <Notice tone="info" live="none">A move of {c.displayName} that QuickBooks didn&apos;t take is kept on the Reconciliation page, so they can&apos;t be made inactive until it is sent or given up there.</Notice>
        : deactivate && c.active && <DeactivateForm label={`Make ${c.displayName} inactive`} warning={warning}
        act={record ? deactivateLinkedAction.bind(null, edit.rosterTag, record.kind, record.id) : deactivateAction.bind(null, edit.rosterTag, c.qboId, version)} />}
      {deactivate && !c.active && follow && record && !(record.kind === "student" && edit.keptMoves?.has(c.qboId)) && <DeactivateForm label={`Make ${c.displayName} inactive in the portal`}
        warning={`QuickBooks has ${c.displayName} inactive already, but the portal's own record is still active. This sends nothing to QuickBooks and makes the portal's record inactive too.`}
        act={deactivateLinkedAction.bind(null, edit.rosterTag, record.kind, record.id)} />}
    </details>
  );
}

/**
 * Making the family inactive, with everyone under it: the list of who that covers, by name, deepest first as the portal
 * makes them inactive. The form is given the names it shows; the family record's app id and the stamp of whom it
 * covered (coverStamp()) are bound into its action on the server.
 */
function FamilyInactive({ family, cover, edit }: { family: Cust; cover: { family: Covered; under: Covered[] }; edit: Edit }) {
  if (cover.under.some((u) => edit.blocked.has(u.qboId))) {
    return <Notice tone="info" live="none">A change to someone under {family.displayName} is waiting to reach QuickBooks, so the family can&apos;t be made inactive for now.</Notice>;
  }
  // Whom the page covered, sealed on the server (coverStamp()): the action trusts no id or version from the browser.
  const stamp = coverStamp(edit.familyId, [cover.family.qboId, ...cover.under.map((u) => u.qboId)]);
  return (
    <>
      {!family.active && <Notice tone="info" live="none">QuickBooks has {family.displayName} inactive already, but the portal&apos;s own family is still active. Making it inactive here sends nothing for it to QuickBooks, and makes the portal&apos;s family inactive too.</Notice>}
      <FamilyInactiveForm familyName={family.displayName} names={cover.under.map((u) => u.name)}
        act={familyInactiveAction.bind(null, edit.rosterTag, edit.familyId, stamp)} />
    </>
  );
}

/** A student of the family's record a move is offered for (MoveStudents): the app's id, and why none is offered now (`blocked`). */
export type MovableStudent = { id: string; name: string; blocked: string | null };

/**
 * Moving the family's students (stage 3's slice 9f), linked or not, to any other of the portal's own active families,
 * linked or not (`families`, by the app's id), on a linked family's page and an unlinked one's alike. The move is saved
 * in the portal first, with what follows it (the student's forms, places on shifts still to come and buy-outs), then
 * sent to QuickBooks for a linked student; their invoices follow once QuickBooks has it (open question 14). Offered
 * only to staff who may change families, where the shape offers a move, for an active family whose own create isn't
 * waiting; a student whose own create, or another change, is waiting is offered none (`blocked`, in words). The action
 * checks everything again.
 */
export function MoveStudents({ students, families, refusedHere, rosterTag, act }: { students: MovableStudent[]; families: { id: string; name: string }[]; refusedHere: string | null;
  rosterTag: string; act: (rosterTag: string, studentId: string, toFamilyId: string) => Promise<WriteResult> }) {
  if (students.length === 0) return null;
  return (
    <section className="box" aria-labelledby="move-students-h"><h2 id="move-students-h">Move a student</h2>
      <p>A move is saved in the portal first, and what follows it happens at once, whatever QuickBooks then does with the move: a completed form goes with the student and an unfinished one starts again in the new family; their places on shifts still to come are given up, and none of their places counts for the family they joined, while the credit they earned stays with the family it was earned for; an unpaid volunteer buy-out invoice of theirs is queued to be voided, and any other buy-out of theirs (a paid one, say) is flagged for the club. For a student linked to QuickBooks the move is then sent there. Their invoices follow once QuickBooks has the move: until then the family QuickBooks has them under still sees them, and the family they joined doesn&apos;t. Where guardians may sign in only to a family with an active student, moving a family&apos;s last active student out keeps its guardians out until it has one again.</p>
      {refusedHere !== null ? <Notice tone="info" live="none">{refusedHere}</Notice>
        : families.length === 0 ? <Notice tone="info" live="none">There is no other family a student can be moved to just now: the portal has no other active family, or each has a change of its own waiting.</Notice> : students.map((s) => (
        <details key={s.id} className="more"><summary>Move the student {s.name}</summary>
          {s.blocked !== null ? <Notice tone="info" live="none">{s.blocked}</Notice> : <MoveForm families={families} act={act.bind(null, rosterTag, s.id)} />}
        </details>
      ))}
    </section>
  );
}

/**
 * Every change a family's page offers in QuickBooks: the family itself, its students and its parents, as the shape
 * allows. Offered only for a family whose own record is active in the portal; a student whose record is inactive
 * (`inactiveRecords`, by customer) is offered nothing that would send. A move is MoveStudents' (slice 9f), for every
 * student of the family's record, wherever QuickBooks has them (the page says where).
 */
export function FamilyChanges({ shape, family, edit, cover, inactiveRecords }: {
  shape: Extract<MembershipShape, { kind: "layered" }>; family: Family; edit: Edit; cover: { family: Covered; under: Covered[] } | null;
  inactiveRecords: Set<string>;
}) {
  const { offered } = shapeOperations(shape);
  const f = family.customer;
  return (
    <section className="box" aria-labelledby="family-changes-h"><h2 id="family-changes-h">Change in QuickBooks</h2>
      <RecordChanges who="the family" c={f} rename={offered.has("rename_family")} deactivate={false} edit={edit} warning=""
        extra={offered.has("deactivate_family") && cover ? <FamilyInactive family={f} cover={cover} edit={edit} /> : null} />
      {f.active && offered.has("add_student") && (
        <details className="more"><summary>Add a student</summary>
          <p className="hint">The student is saved in the portal first, then made in QuickBooks under the family. If QuickBooks refuses, they stay in the portal and the Reconciliation page says why.</p>
          <NameForm field="The student's name, as QuickBooks will show it" label="Add the student" pendingLabel="Saving in the portal, then making them in QuickBooks…" act={addStudentAction.bind(null, edit.rosterTag, edit.familyId)} />
        </details>
      )}
      {family.students.filter((s) => !inactiveRecords.has(s.qboId)).map((s) => (
        <RecordChanges key={s.qboId} who="the student" c={s} rename={offered.has("rename_student")} deactivate={offered.has("deactivate_student")} edit={edit} follow
          warning="The student is no longer counted in the family's season, and their invoices no longer show to the family. A student with any balance in QuickBooks, owed or a credit, isn't made inactive until it is settled there, nor while the portal can't read it." />
      ))}
      {/* A Parent customer a portal guardian is linked to is changed through the guardian (stage 3's slice 9h); one that
          exists in QuickBooks alone keeps its own forms, QuickBooks first, changing nothing in the portal. */}
      {family.parents.map((p) => (edit.guardianCustomers?.get(p.qboId) === "own"
        ? <Notice key={p.qboId} tone="info" live="none">{p.displayName} is a portal guardian&apos;s own Parent customer, so it is changed through them: rename the person on their page, or remove them under Portal sign-ins below.</Notice>
        : edit.guardianCustomers?.get(p.qboId) === "other"
          ? <Notice key={p.qboId} tone="info" live="none">{p.displayName} is linked to a portal guardian, but isn&apos;t one guardian&apos;s own Parent customer under this family (several guardians share it, or the guardian is in another family), so the portal sends nothing for it: change it in QuickBooks, and the mapping screen will sort it out.</Notice>
        : edit.guardianCustomers?.get(p.qboId) === "removed"
          ? <RecordChanges key={p.qboId} who="the parent" c={p} rename={offered.has("rename_parent")} deactivate={offered.has("deactivate_parent")} edit={edit}
            warning="This is the own Parent customer of a guardian removed from this family, left active in QuickBooks because a removal makes it inactive only when its balance allows. Adding them back under Portal sign-ins uses it again, under whatever name it has then. A change here is made in QuickBooks only and changes nothing in the portal. A parent with any balance in QuickBooks, owed or a credit, isn't made inactive until it is settled there, nor while the portal can't read it." />
        : <RecordChanges key={p.qboId} who="the parent" c={p} rename={offered.has("rename_parent")} deactivate={offered.has("deactivate_parent")} edit={edit}
          warning="This Parent customer isn't a portal guardian: who can sign in is the portal's own list of the family's guardians, adding the person under Portal sign-ins doesn't use it, and the mapping screen will offer to link it. Making it inactive changes nothing in the portal. A parent with any balance in QuickBooks, owed or a credit, isn't made inactive until it is settled there, nor while the portal can't read it." />))}
    </section>
  );
}

/** A flat club's member: rename and make inactive. */
export function MemberChanges({ member, edit }: { member: Cust; edit: Edit }) {
  return (
    <section className="box" aria-labelledby="member-changes-h"><h2 id="member-changes-h">Change in QuickBooks</h2>
      <RecordChanges who="the member" c={member} rename deactivate edit={edit} follow warning="They can no longer sign in to the portal. A member with any balance in QuickBooks, owed or a credit, isn't made inactive until it is settled there, nor while the portal can't read it." />
    </section>
  );
}
