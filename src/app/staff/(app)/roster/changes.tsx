import type { ReactNode } from "react";
import type { MembershipShape } from "@/lib/roster/shape";
import type { Cust, Family } from "@/lib/roster/model";
import { NOT_HERE, shapeOperations, type RosterOperation } from "@/lib/roster/operations";
import type { QueueView } from "@/lib/roster/queue";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { DataTable } from "@/app/components/data-table";
import type { Covered } from "@/lib/roster/writes";
import { DeactivateForm, FamilyInactiveForm, MemberForm, MoveForm, NameForm, ParentForm } from "./write-forms";
import { addToFamilyAction, createAction, deactivateAction, familyInactiveAction, moveAction, renameAction } from "./write-actions";

/**
 * The roster's changes in QuickBooks, for staff who hold Roster.Family.ReadWrite with Roster.Read. Every form's action
 * has the page's roster tag, the record's id and the version the page was shown bound in; names are QuickBooks text,
 * shown as text only.
 */

/** What can be changed here for this club, and why the rest can't, in words (src/lib/roster/operations.ts). */
export function WhatChanges({ shape, canChange }: { shape: MembershipShape; canChange: boolean }) {
  const { offered, notOffered } = shapeOperations(shape);
  const words: [RosterOperation, string][] = shape.kind === "flat"
    ? [["create_member", "make a member"], ["rename_member", "rename one"], ["deactivate_member", "make one inactive"]]
    : [["create_family", "make a family"], ["add_student", "add a student"], ["add_parent", "add a parent with their own email address"],
        ["rename_family", "rename a family, student or parent"], ["move_student", "move a student to another family"], ["deactivate_family", "make a family, student or parent inactive"]];
  const can = words.filter(([o]) => offered.has(o)).map(([, w]) => w);
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}` : can[0] ?? "";
  return (
    <section className="box" aria-labelledby="changes-h"><h2 id="changes-h">Changing the roster</h2>
      <p>{canChange ? <>From the portal you can {list}. Each change is sent to QuickBooks first, and the roster shows it once QuickBooks has it.</>
        : <>Staff who may change the roster can {list} from the portal. Each change is sent to QuickBooks first.</>}</p>
      {notOffered.map((n) => <p key={n.why}>{n.why}</p>)}
      <p>{NOT_HERE.contact}</p>
    </section>
  );
}

/** The writes waiting or stuck for this family or member: shown to everyone who can see the page. */
export function Waiting({ items }: { items: QueueView[] }) {
  if (!items.length) return null;
  return (
    <section className="box" aria-labelledby="waiting-h"><h2 id="waiting-h">Waiting to reach QuickBooks</h2>
      <p>These changes were asked for but QuickBooks hasn&apos;t taken them yet. Nothing else can be changed on the same record until they go through or are given up on the <a href="/staff/reconciliation">Reconciliation page</a>.</p>
      <DataTable caption="Each change, and where it stands" captionHidden rows={items} rowKey={(i) => i.id} columns={[
        { key: "change", header: "Change", rowHeader: true, cell: (i) => i.words },
        { key: "state", header: "Where it stands", cell: (i) => (i.state === "stuck" ? "Stuck: it needs someone to look at it" : "Waiting to reach QuickBooks") },
        { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? ` by ${i.askedBy}` : ""}</> },
      ]} />
    </section>
  );
}

/** Making a new family, or a new member, from the roster list. */
export function CreateBox({ shape, rosterTag, memberTypes }: { shape: MembershipShape; rosterTag: string; memberTypes: { qboId: string; name: string }[] }) {
  if (shape.kind === "flat") {
    return (
      <section className="box" aria-labelledby="create-h"><h2 id="create-h">Make a member</h2>
        <p>Made in QuickBooks as a customer of the member type{memberTypes.length > 1 ? " you choose" : ""}. Their email address and phone are added in QuickBooks.</p>
        <MemberForm types={memberTypes} act={createAction.bind(null, rosterTag, "member")} />
      </section>
    );
  }
  return (
    <section className="box" aria-labelledby="create-h"><h2 id="create-h">Make a family</h2>
      <p>Made in QuickBooks as a customer of the family type. Add its students and parents from the family&apos;s page once it is made.</p>
      <NameForm field="The family's name, as QuickBooks will show it" label="Make the family" pendingLabel="Making it in QuickBooks…" act={createAction.bind(null, rosterTag, "family")} />
    </section>
  );
}

type Edit = { rosterTag: string; versions: Map<string, string>; blocked: Set<string> };

/** Rename and make inactive, for one record: offered only when the shape allows it and nothing is waiting for it. */
function RecordChanges({ who, c, rename, deactivate, warning, edit, extra }: {
  who: string; c: Cust; rename: boolean; deactivate: boolean; warning: string; edit: Edit; extra?: ReactNode;
}) {
  const version = edit.versions.get(c.qboId);
  if (version === undefined) return null;
  if (edit.blocked.has(c.qboId)) return <Notice tone="info" live="none">A change to {c.displayName} is waiting to reach QuickBooks, so nothing else can be changed for now.</Notice>;
  return (
    <details className="more"><summary>Change {who} {c.displayName}</summary>
      {rename && <NameForm field="New name" label="Rename" pendingLabel="Renaming in QuickBooks…" initial={c.displayName} act={renameAction.bind(null, edit.rosterTag, c.qboId, version)} />}
      {extra}
      {deactivate && c.active && <DeactivateForm label={`Make ${c.displayName} inactive`} warning={warning} act={deactivateAction.bind(null, edit.rosterTag, c.qboId, version)} />}
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
  return <FamilyInactiveForm familyName={family.displayName} names={cover.under.map((u) => u.name)}
    act={familyInactiveAction.bind(null, edit.rosterTag, family.qboId, shown)} />;
}

/** Every change a family's page offers: the family itself, its students and its parents, as the shape allows. */
export function FamilyChanges({ shape, family, families, edit, cover }: {
  shape: Extract<MembershipShape, { kind: "layered" }>; family: Family; families: { qboId: string; name: string }[]; edit: Edit; cover: { family: Covered; under: Covered[] } | null;
}) {
  const { offered } = shapeOperations(shape);
  const f = family.customer;
  const elsewhere = families.filter((x) => x.qboId !== f.qboId);
  return (
    <section className="box" aria-labelledby="family-changes-h"><h2 id="family-changes-h">Change in QuickBooks</h2>
      <RecordChanges who="the family" c={f} rename={offered.has("rename_family")} deactivate={false} edit={edit} warning=""
        extra={offered.has("deactivate_family") && f.active && cover ? <FamilyInactive family={f} cover={cover} edit={edit} /> : null} />
      {f.active && offered.has("add_student") && (
        <details className="more"><summary>Add a student</summary>
          <NameForm field="The student's name, as QuickBooks will show it" label="Add the student" pendingLabel="Adding in QuickBooks…" act={addToFamilyAction.bind(null, edit.rosterTag, "student", f.qboId)} />
        </details>
      )}
      {f.active && offered.has("add_parent") && (
        <details className="more"><summary>Add a parent</summary>
          <ParentForm act={addToFamilyAction.bind(null, edit.rosterTag, "parent", f.qboId)} />
        </details>
      )}
      {family.students.map((s) => (
        <RecordChanges key={s.qboId} who="the student" c={s} rename={offered.has("rename_student")} deactivate={offered.has("deactivate_student")} edit={edit}
          warning="The student is no longer counted in the family's season, and their invoices no longer show to the family. A student with an open balance in QuickBooks isn't made inactive until it is paid or written off."
          extra={offered.has("move_student") && s.active && edit.versions.has(s.qboId) && elsewhere.length > 0
            ? <MoveForm families={elsewhere} act={moveAction.bind(null, edit.rosterTag, s.qboId, edit.versions.get(s.qboId)!)} /> : null} />
      ))}
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
      <RecordChanges who="the member" c={member} rename deactivate edit={edit} warning="They can no longer sign in to the portal. A member with an open balance in QuickBooks isn't made inactive until it is paid or written off." />
    </section>
  );
}
