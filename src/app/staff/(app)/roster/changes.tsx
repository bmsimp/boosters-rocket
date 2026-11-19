import type { ReactNode } from "react";
import type { MembershipShape } from "@/lib/roster/shape";
import type { Cust, Family } from "@/lib/roster/model";
import { NOT_HERE, shapeOperations, type RosterOperation } from "@/lib/roster/operations";
import { waitingWords, type QueueView } from "@/lib/roster/queue";
import { keptRefusalWords } from "@/lib/roster/writes";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { DataTable } from "@/app/components/data-table";
import type { Covered } from "@/lib/roster/writes";
import { CreateAndLinkForm, DeactivateForm, FamilyInactiveForm, MemberForm, MoveForm, NameForm, ParentForm } from "./write-forms";
import { addStudentAction, addStudentHereAction, addToFamilyAction, createAction, createAndLinkAction, deactivateAction, deactivateHereAction, familyInactiveAction, moveAction,
  renameHereAction, renameLinkedAction, renameParentAction } from "./write-actions";

/**
 * The roster's changes in QuickBooks, for staff who hold Roster.Family.ReadWrite with Roster.Read. Every form's action
 * has the page's roster tag and the record's id bound in: a rename of a linked family, member or student, and a new
 * student, the app's id (saved in the portal first, stage 3's slice 9e, and sent with the link's own version); a move,
 * a make-inactive and a parent's changes, the customer's id and the version the page was shown. Names are QuickBooks
 * text, or the portal's own, shown as text only.
 */

/** What can be changed here for this club, and why the rest can't, in words (src/lib/roster/operations.ts). */
export function WhatChanges({ shape, canChange, unlinked = false }: { shape: MembershipShape; canChange: boolean; unlinked?: boolean }) {
  const { offered, notOffered } = shapeOperations(shape);
  const words: [RosterOperation, string][] = shape.kind === "flat"
    ? [["create_member", "make a member"], ["rename_member", "rename one"], ["deactivate_member", "make one inactive"]]
    : [["create_family", "make a family"], ["add_student", "add a student"], ["add_parent", "add a parent with their own email address"],
        ["rename_family", "rename a family, student or parent"], ["move_student", "move a student to another family"], ["deactivate_family", "make a family, student or parent inactive"]];
  const can = words.filter(([o]) => offered.has(o)).map(([, w]) => w);
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}` : can[0] ?? "";
  return (
    <section className="box" aria-labelledby="changes-h"><h2 id="changes-h">Changing the roster</h2>
      <p>{canChange ? <>From the portal you can {list}. For a family linked to QuickBooks, a rename or a new student is saved in the portal first and then sent to QuickBooks; if QuickBooks refuses it, the portal keeps it and the Reconciliation page lists it. A move, or making someone inactive, is sent to QuickBooks first, and the roster shows it once QuickBooks has it.</>
        : <>Staff who may change the roster can {list} from the portal. For a family linked to QuickBooks, a rename or a new student is saved in the portal first; a move, or making someone inactive, is sent to QuickBooks first.</>}</p>
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
 * Reconciliation page has them). A refused change blocks nothing here.
 */
export function Waiting({ items }: { items: QueueView[] }) {
  const open = items.filter((i) => i.state !== "refused"), refused = items.filter((i) => i.state === "refused");
  return (
    <>
      {open.length > 0 && (
        <section className="box" aria-labelledby="waiting-h"><h2 id="waiting-h">Waiting to reach QuickBooks</h2>
          <p>These changes were asked for and haven&apos;t been finished yet: most are waiting for QuickBooks to take them. Nothing else can be changed on the same record until they go through or are given up on the <a href="/staff/reconciliation">Reconciliation page</a>.</p>
          <DataTable caption="Each change, and where it stands" captionHidden rows={open} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => i.words },
            { key: "state", header: "Where it stands", cell: (i) => waitingWords(i) },
            { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
          ]} />
        </section>
      )}
      {refused.length > 0 && (
        <section className="box" aria-labelledby="refused-h"><h2 id="refused-h">Kept in the portal, refused by QuickBooks</h2>
          <p>These changes are saved in the portal, but QuickBooks refused them, so QuickBooks still has something else. They don&apos;t stop other changes. On the <a href="/staff/reconciliation">Reconciliation page</a>, someone who may change families can send the portal&apos;s value again or give it up.</p>
          <DataTable caption="Each change QuickBooks refused, and why" captionHidden rows={refused} rowKey={(i) => i.id} columns={[
            { key: "change", header: "Change", rowHeader: true, cell: (i) => i.words },
            { key: "why", header: "Why", cell: (i) => keptRefusalWords(i.lastCode, i.holds) },
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
        <p>{addGoesWords(goes, "member", `member type${memberTypes.length > 1 ? " you choose" : ""}`)} Their email address and phone are added in QuickBooks.</p>
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
 * What the forms of a family's page are given: the roster tag, each customer's version (for a move, a make-inactive and
 * a parent's rename), the customers a change waits for, the family record's app id (for a new student), and each linked
 * record by its customer (`records`: the family's or member's own, and each student's), whose rename is saved in the
 * portal first and starts from the portal's own name.
 */
export type Edit = { rosterTag: string; versions: Map<string, string>; blocked: Set<string>; familyId: string;
  records: Map<string, { kind: "family" | "student"; id: string; name: string }> };

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
      {deactivate && c.active && <DeactivateForm label={`Make ${c.displayName} inactive`} warning={warning} act={deactivateAction.bind(null, edit.rosterTag, c.qboId, version)} />}
      {deactivate && !c.active && follow && <DeactivateForm label={`Make ${c.displayName} inactive in the portal`}
        warning={`QuickBooks has ${c.displayName} inactive already, but the portal's own record is still active. This sends nothing to QuickBooks and makes the portal's record inactive too.`}
        act={deactivateAction.bind(null, edit.rosterTag, c.qboId, version)} />}
    </details>
  );
}

/**
 * Making the family inactive, with everyone under it: the list of who that covers, by name, deepest first as the portal
 * makes them inactive. The form is given the names it shows; the ids and versions are bound into its action on the server.
 */
function FamilyInactive({ family, cover, edit }: { family: Cust; cover: { family: Covered; under: Covered[] }; edit: Edit }) {
  if (cover.under.some((u) => edit.blocked.has(u.qboId))) {
    return <Notice tone="info" live="none">A change to someone under {family.displayName} is waiting to reach QuickBooks, so the family can&apos;t be made inactive for now.</Notice>;
  }
  const shown: [string, string][] = [[cover.family.qboId, cover.family.syncToken], ...cover.under.map((u): [string, string] => [u.qboId, u.syncToken])];
  return (
    <>
      {!family.active && <Notice tone="info" live="none">QuickBooks has {family.displayName} inactive already, but the portal&apos;s own family is still active. Making it inactive here sends nothing for it to QuickBooks, and makes the portal&apos;s family inactive too.</Notice>}
      <FamilyInactiveForm familyName={family.displayName} names={cover.under.map((u) => u.name)}
        act={familyInactiveAction.bind(null, edit.rosterTag, family.qboId, shown)} />
    </>
  );
}

/** A student of this family's record whom QuickBooks has under another family: in the roster's words. */
export type Elsewhere = { name: string; customer: Cust; familyQboId: string; familyName: string };

/**
 * Every change a family's page offers: the family itself, its students and its parents, as the shape allows. Offered
 * only for a family whose own record is active in the portal; a student whose record is inactive (`inactiveRecords`,
 * by customer) is offered nothing that would send. A student whose record is this family's but whom QuickBooks has
 * under another family (`elsewhere`) is offered the move to that family, which sends nothing and brings the record,
 * with what follows a move, into line; when that family isn't one of `families` (the app's own active families, active
 * in QuickBooks), the record can't follow it there, and the move offered is one sent to QuickBooks, to one of them.
 */
export function FamilyChanges({ shape, family, families, edit, cover, inactiveRecords, elsewhere }: {
  shape: Extract<MembershipShape, { kind: "layered" }>; family: Family; families: { qboId: string; name: string }[]; edit: Edit; cover: { family: Covered; under: Covered[] } | null;
  inactiveRecords: Set<string>; elsewhere: Elsewhere[];
}) {
  const { offered } = shapeOperations(shape);
  const f = family.customer;
  const others = families.filter((x) => x.qboId !== f.qboId);
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
      {f.active && offered.has("add_parent") && (
        <details className="more"><summary>Add a parent</summary>
          <p className="hint">This adds their record in QuickBooks only: it gives them no sign-in to the portal. To let them sign in, add them under Portal sign-ins.</p>
          <ParentForm act={addToFamilyAction.bind(null, edit.rosterTag, "parent", f.qboId)} />
        </details>
      )}
      {family.students.filter((s) => !inactiveRecords.has(s.qboId)).map((s) => (
        <RecordChanges key={s.qboId} who="the student" c={s} rename={offered.has("rename_student")} deactivate={offered.has("deactivate_student")} edit={edit} follow
          warning="The student is no longer counted in the family's season, and their invoices no longer show to the family. A student with an open balance in QuickBooks isn't made inactive until it is paid or written off."
          extra={offered.has("move_student") && s.active && edit.versions.has(s.qboId) && others.length > 0
            ? <MoveForm families={others} act={moveAction.bind(null, edit.rosterTag, s.qboId, edit.versions.get(s.qboId)!)} /> : null} />
      ))}
      {offered.has("move_student") && elsewhere.map((s) => {
        const version = edit.versions.get(s.customer.qboId);
        if (version === undefined) return null;
        if (edit.blocked.has(s.customer.qboId)) return <Notice key={s.customer.qboId} tone="info" live="none">A change to {s.name} is waiting to reach QuickBooks, so nothing else can be changed for now.</Notice>;
        // The family QuickBooks has them under isn't one of the portal's own active families (made in QuickBooks alone,
        // or inactive there or here): the record can't follow them there, so the move offered is one sent to
        // QuickBooks, to one of the portal's families, this one included (prepare() in src/lib/roster/writes.ts).
        if (!families.some((x) => x.qboId === s.familyQboId)) return (
          <details key={s.customer.qboId} className="more"><summary>Change the student {s.name}</summary>
            <p>QuickBooks has {s.name} under {s.familyName}, which isn&apos;t one of the portal&apos;s own active families, so the portal&apos;s own record of them can&apos;t follow them there. Moving them here sends the move to QuickBooks: back to this family puts QuickBooks in line with the portal, and to another family their record, forms, places on shifts still to come and buy-outs go with them.</p>
            {families.length > 0 ? <MoveForm families={families} act={moveAction.bind(null, edit.rosterTag, s.customer.qboId, version)} />
              : <Notice tone="info" live="none">The portal has no active family to move them to.</Notice>}
          </details>
        );
        return (
          <details key={s.customer.qboId} className="more"><summary>Change the student {s.name}</summary>
            <p>QuickBooks has {s.name} under {s.familyName}, but the portal still holds them in this family. Moving them to {s.familyName} here sends nothing to QuickBooks: the portal&apos;s own record moves, and their forms, places on shifts still to come and buy-outs follow as they do for any move.</p>
            <MoveForm families={[{ qboId: s.familyQboId, name: s.familyName }]} act={moveAction.bind(null, edit.rosterTag, s.customer.qboId, version)} />
          </details>
        );
      })}
      {family.parents.map((p) => (
        <RecordChanges key={p.qboId} who="the parent" c={p} rename={offered.has("rename_parent")} deactivate={offered.has("deactivate_parent")} edit={edit}
          warning="Their sign-in to the portal stays as it is: who can sign in is the portal's own list of the family's guardians. A parent with an open balance in QuickBooks isn't made inactive until it is paid or written off." />
      ))}
    </section>
  );
}

/** A flat club's member: rename and make inactive. */
export function MemberChanges({ member, edit }: { member: Cust; edit: Edit }) {
  return (
    <section className="box" aria-labelledby="member-changes-h"><h2 id="member-changes-h">Change in QuickBooks</h2>
      <RecordChanges who="the member" c={member} rename deactivate edit={edit} follow warning="They can no longer sign in to the portal. A member with an open balance in QuickBooks isn't made inactive until it is paid or written off." />
    </section>
  );
}
