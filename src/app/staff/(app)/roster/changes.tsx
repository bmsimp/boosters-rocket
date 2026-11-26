import type { ReactNode } from "react";
import Link from "next/link";
import type { MembershipShape } from "@/lib/roster/shape";
import type { Cust, Family } from "@/lib/roster/model";
import { NOT_HERE, shapeOperations, type RosterOperation } from "@/lib/roster/operations";
import { waitingWords, type QueueView } from "@/lib/roster/queue";
import { coverStamp, keptWordsFor } from "@/lib/roster/writes";
import { LocalTime } from "@/app/components/local-time";
import { Card, DataTable, Drawer, Notice } from "@/app/components/ui";
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

/**
 * What can be changed here for this club, and why the rest can't, in words (src/lib/roster/operations.ts): a line or
 * two, in the open. The roster page's alone: a family's page says what it needs in its own cards (ChangesInQuickBooks
 * below, Move a student, Add a guardian).
 */
export function WhatChanges({ shape, canChange, unlinked = false }: { shape: MembershipShape; canChange: boolean; unlinked?: boolean }) {
  const { offered, notOffered } = shapeOperations(shape);
  const words: [RosterOperation, string][] = shape.kind === "flat"
    ? [["create_member", "make a member"], ["rename_member", "rename one"], ["deactivate_member", "make one inactive"]]
    : [["create_family", "make a family"], ["add_student", "add a student"], ["add_parent", "give each new guardian their own Parent customer"],
        ["rename_family", "rename a family, student or parent"], ["move_student", "move a student to another family"], ["deactivate_family", "make a family, student or parent inactive"]];
  const can = words.filter(([o]) => offered.has(o)).map(([, w]) => w);
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}` : can[0] ?? "";
  return (
    <Card title="Changing the roster" titleId="changes-h">
      <p>{canChange ? <>From the portal you can {list}.</> : <>Staff who may change the roster can {list} from the portal.</>}{" "}
        {unlinked ? "This family isn't linked to QuickBooks, so a change to it is saved here only."
          : "A change to a linked family is saved here first, then sent to QuickBooks; making someone inactive goes to QuickBooks first."}</p>
      {notOffered.map((n) => <p key={n.why} className="hint">{n.why}</p>)}
    </Card>
  );
}

/**
 * The writes waiting or stuck for this family or member, and the changes saved in the portal first that QuickBooks
 * refused (stage 3's slice 9e), each under its own heading: shown to everyone who can see the page, with no buttons (the
 * Reconciliation page has them). A refused change blocks nothing here, but that a kept move holds back making either of
 * its families inactive (MOVE_PENDING) until it is sent or given up. `compare`: the kept changes of a guardian's phone
 * and mailing address the reader may open in Reconciliation's compare view (Parents.ReadWrite: stage 3's slice 11c),
 * each one whose record still stands by the compare view's own rule (comparableContacts()); empty for anyone else.
 */
export function Waiting({ items, compare = new Set<string>() }: { items: QueueView[]; compare?: ReadonlySet<string> }) {
  const open = items.filter((i) => i.state !== "refused"), refused = items.filter((i) => i.state === "refused");
  return (
    <>
      {open.length > 0 && (
        <Card title="Waiting to reach QuickBooks" titleId="waiting-h">
          <p>These haven&apos;t reached QuickBooks yet. Until each goes through or is given up on <a href="/staff/reconciliation">Reconciliation</a>, nothing else can be changed on its record. A guardian&apos;s phone, mailing address and sign-in email don&apos;t hold anything back.</p>
          <DataTable caption="Each change, and where it stands" captionHidden rows={open} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => <>{i.words}{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</> },
            { key: "state", header: "Where it stands", cell: (i) => waitingWords(i) },
            { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
          ]} />
        </Card>
      )}
      {refused.length > 0 && (
        <Card title="Kept in the portal, not in QuickBooks" titleId="refused-h">
          <p>Saved here, but QuickBooks still has something else. They don&apos;t block other changes, except that a kept move stops either family being made inactive. On <a href="/staff/reconciliation">Reconciliation</a>, someone who may change families can send the portal&apos;s value again or give it up.</p>
          <DataTable caption="Each change that didn't go through, and why" captionHidden rows={refused} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => <>{i.words}{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</> },
            { key: "why", header: "Why", cell: (i) => <>{keptWordsFor(i.write, i.lastCode, i.holds, i.differs, i.joined)}{i.write.op === "contact" && compare.has(i.id)
              ? <a className="link-line" href={`/staff/reconciliation?compare=${i.id}#writes-h`}>Compare the two</a> : null}</> },
            { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
          ]} />
        </Card>
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
  ? `It's saved here first, then made in QuickBooks as a ${type} customer and linked.`
  : goes === "no_permission"
    ? `It's saved in the portal only. Someone who can link families can then press “Create in QuickBooks and link” on its page.`
    : `It's saved in the portal only, as QuickBooks isn't connected. Once it is, someone who can link families can press “Create in QuickBooks and link” on its page.`;

/** Making a new family, or a new member, from the roster list: the portal's own record first (stage 3's slice 9d). */
export function CreateBox({ shape, rosterTag, memberTypes, goes }: { shape: MembershipShape; rosterTag: string; memberTypes: { qboId: string; name: string }[]; goes: AddGoesTo }) {
  const pendingLabel = goes === "sends" ? "Saving, then making it in QuickBooks…" : "Saving…";
  if (shape.kind === "flat") {
    return (
      <Card title="Make a member" titleId="create-h">
        <p>{addGoesWords(goes, "member", `member type${memberTypes.length > 1 ? " you choose" : ""}`)} Add their email address in QuickBooks. Their phone and mailing address are the portal&apos;s own: guardians set them on their Family page, and staff on the member&apos;s page. Each change is sent on to QuickBooks.</p>
        <MemberForm types={goes === "sends" ? memberTypes : []} pendingLabel={pendingLabel} act={createAction.bind(null, rosterTag, "member")} />
      </Card>
    );
  }
  return (
    <Card title="Make a family" titleId="create-h">
      <p>{addGoesWords(goes, "family", "family type")} Add its students and guardians from the family&apos;s page once it is saved.</p>
      <NameForm field="The family's name" label="Make the family" variant="primary" pendingLabel={pendingLabel} act={createAction.bind(null, rosterTag, "family")} />
    </Card>
  );
}

/** A student of the family's record with no link to a customer in QuickBooks, for the portal's own changes. */
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
    <Card title="Change in the portal" titleId="portal-changes-h">
      <p>{unlinked ? `This ${noun} isn't linked to QuickBooks, so changes are saved here only.`
        : "These students aren't linked to QuickBooks, so changes to them are saved here only."}</p>
      {unlinked && (
        <Drawer param="change-here" label={`Change the ${noun} ${name}`} description="Saved in the portal only.">
          <NameForm field="New name" label="Rename" pendingLabel="Renaming…" initial={name} act={renameHereAction.bind(null, rosterTag, "family", familyId)} />
          <DeactivateForm label={`Make ${name} inactive`}
            warning={`This makes ${name} inactive${noun === "family" ? ", with its students" : ""}, and its guardians can no longer sign in. It can't be made active again, and its page goes away. Its season, forms and volunteering are kept. Nothing is sent to QuickBooks.`}
            act={deactivateHereAction.bind(null, rosterTag, "family", familyId)} />
        </Drawer>
      )}
      {unlinked && addStudents && (
        <Drawer param="add-student-here" label="Add a student" description="Saved in the portal only.">
          <NameForm field="The student's name" label="Add the student" pendingLabel="Adding…" act={addStudentHereAction.bind(null, rosterTag, familyId)} />
        </Drawer>
      )}
      {students.map((s) => (
        <Drawer key={s.id} param="change-student-here" value={s.id} label={`Change the student ${s.name}`} description="Saved in the portal only.">
          <NameForm field="New name" label="Rename" pendingLabel="Renaming…" initial={s.name} act={renameHereAction.bind(null, rosterTag, "student", s.id)} />
          <DeactivateForm label={`Make ${s.name} inactive`} warning={`${s.name} is no longer counted in the family's season. Nothing is sent to QuickBooks: they aren't linked to a customer there.`}
            act={deactivateHereAction.bind(null, rosterTag, "student", s.id)} />
        </Drawer>
      ))}
    </Card>
  );
}

/**
 * "Create in QuickBooks and link" (stage 3's slice 9d), for an active family with no link or with students with none:
 * what pressing it makes, and the button for staff who may change families and link them to accounting (`may`), while
 * QuickBooks is connected to the roster's company (`ready`). Anyone else who may change families is told who can.
 * `notOffered`: the active students with no link it leaves out (stage 4's slice M3b2), each with the customer they were
 * linked to until the family they were in was unlinked, which the books still hold (QuickBooks text, as text).
 */
export function CreateInQuickBooks({ familyId, name, noun, unlinked, students, notOffered = [], types, rosterTag, may, ready }: {
  familyId: string; name: string; noun: "family" | "member"; unlinked: boolean; students: string[]; notOffered?: { name: string; customer: string }[]; types: { qboId: string; name: string }[];
  rosterTag: string; may: boolean; ready: boolean;
}) {
  const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const what = unlinked
    ? `This makes ${name} a customer in QuickBooks${students.length ? `, then ${listed(students)} under it` : ""}, and links each. Its invoices then show to its guardians.`
    : `This makes ${listed(students)} customers in QuickBooks under ${name}, one by one, and links each to their record here.`;
  return (
    <Card title="Create in QuickBooks and link" titleId="create-link-h">
      <p>{what} If one can&apos;t be made, it stops and says why. Press again to carry on.</p>
      {notOffered.map((s) => <Notice key={`${s.name}:${s.customer}`} tone="info" live="none">{s.name} isn&apos;t offered: they were linked to &ldquo;{s.customer}&rdquo; in QuickBooks until the family they were in was unlinked, and &ldquo;{s.customer}&rdquo; is still there, so a second customer isn&apos;t made for them.</Notice>)}
      {!ready ? <Notice tone="info" live="none">QuickBooks isn&apos;t connected to this roster&apos;s company, so nothing can be made there now.</Notice>
        : !may ? <Notice tone="info" live="none">Someone who can link families can make it in QuickBooks and link it.</Notice>
        : <CreateAndLinkForm types={unlinked && noun === "member" ? types : []} act={createAndLinkAction.bind(null, rosterTag, familyId)} />}
    </Card>
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
    <Drawer param="change" value={c.qboId} label={`Change ${who} ${c.displayName}`}>
      {rename && (record ? <NameForm field="New name" label="Rename" pendingLabel="Saving in the portal, then sending to QuickBooks…" initial={record.name}
        act={renameLinkedAction.bind(null, edit.rosterTag, record.kind, record.id)} />
        : <NameForm field="New name" label="Rename" pendingLabel="Renaming in QuickBooks…" initial={c.displayName} act={renameParentAction.bind(null, edit.rosterTag, c.qboId, version)} />)}
      {extra}
      {deactivate && record?.kind === "student" && edit.keptMoves?.has(c.qboId) ? <Notice tone="info" live="none">A move of {c.displayName} that QuickBooks didn&apos;t take is kept on the Reconciliation page, so they can&apos;t be made inactive until it is sent or given up there.</Notice>
        : deactivate && c.active && <DeactivateForm label={`Make ${c.displayName} inactive`} warning={warning}
        act={record ? deactivateLinkedAction.bind(null, edit.rosterTag, record.kind, record.id) : deactivateAction.bind(null, edit.rosterTag, c.qboId, version)} />}
      {deactivate && !c.active && follow && record && !(record.kind === "student" && edit.keptMoves?.has(c.qboId)) && <DeactivateForm label={`Make ${c.displayName} inactive in the portal`}
        warning={`QuickBooks already has ${c.displayName} inactive. This makes the portal's record match, and sends nothing.`}
        act={deactivateLinkedAction.bind(null, edit.rosterTag, record.kind, record.id)} />}
    </Drawer>
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
      {!family.active && <Notice tone="info" live="none">QuickBooks already has {family.displayName} inactive. Making it inactive here makes the portal&apos;s family match, and sends nothing for it.</Notice>}
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
    <Card title="Move a student" titleId="move-students-h">
      <p>A move takes effect here at once, and a linked student&apos;s is then sent to QuickBooks; until QuickBooks has it, the old family still sees their invoices. Completed forms and earned credit stay where they are, unfinished forms start again, places on shifts still to come are given up, and an unpaid buy-out invoice is voided.</p>
      <p className="hint">If the club asks for an active student to sign in, moving a family&apos;s last one out keeps its guardians out until it has another.</p>
      {refusedHere !== null ? <Notice tone="info" live="none">{refusedHere}</Notice>
        : families.length === 0 ? <Notice tone="info" live="none">No other family can take a student right now: there is none active, or each has a change waiting.</Notice> : students.map((s) => (
        s.blocked !== null ? <Notice key={s.id} tone="info" live="none">{s.name}: {s.blocked}</Notice> : (
          <Drawer key={s.id} param="move" value={s.id} label={`Move the student ${s.name}`}>
            <MoveForm families={families} act={act.bind(null, rosterTag, s.id)} />
          </Drawer>
        )
      ))}
    </Card>
  );
}

/**
 * Every change a family's page offers in QuickBooks: the family itself, its students and its parents, as the shape
 * allows. Offered only for a family whose own record is active in the portal; a student whose record is inactive
 * (`inactiveRecords`, by customer) is offered nothing that would send. A move is MoveStudents' (slice 9f), for every
 * student of the family's record, wherever QuickBooks has them (the page says where).
 */
export function FamilyChanges({ shape, family, edit, cover, inactiveRecords, linker = false }: {
  shape: Extract<MembershipShape, { kind: "layered" }>; family: Family; edit: Edit; cover: { family: Covered; under: Covered[] } | null;
  inactiveRecords: Set<string>;
  /** Whether the reader may link families to accounting (Accounting.Link.ReadWrite): Accounting links is then a link. */
  linker?: boolean;
}) {
  const { offered } = shapeOperations(shape);
  const f = family.customer;
  return (
    <Card title="Change in QuickBooks" titleId="family-changes-h">
      <ChangesInQuickBooks shape={shape} />
      <RecordChanges who="the family" c={f} rename={offered.has("rename_family")} deactivate={false} edit={edit} warning=""
        extra={offered.has("deactivate_family") && cover ? <FamilyInactive family={f} cover={cover} edit={edit} /> : null} />
      {f.active && offered.has("add_student") && (
        <Drawer param="add-student" label="Add a student" description="They're saved in the portal first, then made in QuickBooks under the family. If QuickBooks refuses, Reconciliation says why.">
          <NameForm field="The student's name, as QuickBooks will show it" label="Add the student" pendingLabel="Saving in the portal, then making them in QuickBooks…" act={addStudentAction.bind(null, edit.rosterTag, edit.familyId)} />
        </Drawer>
      )}
      {family.students.filter((s) => !inactiveRecords.has(s.qboId)).map((s) => (
        <RecordChanges key={s.qboId} who="the student" c={s} rename={offered.has("rename_student")} deactivate={offered.has("deactivate_student")} edit={edit} follow
          warning="They're no longer counted in the family's season, and their invoices stop showing to the family. If QuickBooks shows a balance, owed or a credit, or the portal can't read it, nothing is made inactive until it's settled there." />
      ))}
      {/* A Parent customer a portal guardian is linked to is changed through the guardian (stage 3's slice 9h); one that
          exists in QuickBooks alone keeps its own forms, QuickBooks first, changing nothing in the portal. */}
      {family.parents.map((p) => (edit.guardianCustomers?.get(p.qboId) === "own"
        ? <Notice key={p.qboId} tone="info" live="none">{p.displayName} is a portal guardian&apos;s own Parent customer, so it is changed through them: rename the person on their page, or remove them under Portal sign-ins below.</Notice>
        : edit.guardianCustomers?.get(p.qboId) === "other"
          ? <Notice key={p.qboId} tone="info" live="none">{p.displayName} is shared by several guardians, or belongs to a guardian in another family, so the portal sends nothing for it. Change it in QuickBooks. Or, on {linker ? <Link href="/staff/links">Accounting links</Link> : "Accounting links, by someone who can link families,"} unlink each guardian it doesn&apos;t belong to. Once only one of this family&apos;s guardians is on it, it&apos;s theirs. If none is left on it, link one there.</Notice>
        : edit.guardianCustomers?.get(p.qboId) === "removed"
          ? <RecordChanges key={p.qboId} who="the parent" c={p} rename={offered.has("rename_parent")} deactivate={offered.has("deactivate_parent")} edit={edit}
            warning="A removed guardian's own Parent customer, left active because of its balance. Adding them back uses it again, under whatever name it has then. A change here is made in QuickBooks only. If QuickBooks shows a balance, owed or a credit, or the portal can't read it, nothing is made inactive until it's settled there." />
        : <RecordChanges key={p.qboId} who="the parent" c={p} rename={offered.has("rename_parent")} deactivate={offered.has("deactivate_parent")} edit={edit}
          warning="No portal guardian is linked to this Parent customer. Who can sign in comes from Portal sign-ins, and adding someone there doesn't use it. While it's active, an unlinked guardian of this family can be linked to it on Accounting links. Making it inactive changes nothing in the portal. If QuickBooks shows a balance, owed or a credit, or the portal can't read it, nothing is made inactive until it's settled there." />))}
    </Card>
  );
}

/** What a family's or member's changes in QuickBooks do, in a line or two: the roster page says it in Changing the roster. */
function ChangesInQuickBooks({ shape }: { shape: MembershipShape }) {
  return (
    <>
      <p>A rename, new student or move of a linked family is saved here first, then sent; if QuickBooks refuses, Reconciliation lists it. Making someone inactive goes to QuickBooks first.</p>
      {shapeOperations(shape).notOffered.map((n) => <p key={n.why} className="hint">{n.why}</p>)}
      <p className="hint">{NOT_HERE.contact}</p>
    </>
  );
}

/** A flat club's member: rename and make inactive. */
export function MemberChanges({ member, edit, shape }: { member: Cust; edit: Edit; shape: MembershipShape }) {
  return (
    <Card title="Change in QuickBooks" titleId="member-changes-h">
      <ChangesInQuickBooks shape={shape} />
      <RecordChanges who="the member" c={member} rename deactivate edit={edit} follow warning="They can no longer sign in. If QuickBooks shows a balance, owed or a credit, or the portal can't read it, nothing is made inactive until it's settled there." />
    </Card>
  );
}
