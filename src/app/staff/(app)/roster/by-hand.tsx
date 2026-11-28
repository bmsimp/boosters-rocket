import type { StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyHere, listFamilies, moveTargetsHere, type FamilyRow } from "@/lib/families/list";
import { familySignins } from "@/lib/parents/directory";
import { Button, Card, DataTable, Drawer, EmptyState, Notice, PageHeader, StatusBadge, TextInput, Toolbar, type Column } from "@/app/components/ui";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { PortalChanges } from "./changes";
import { DeactivateForm, MoveForm, NameForm } from "./write-forms";
import { createAction, deactivateHereAction, moveAction, renameHereAction } from "./write-actions";
import { Elsewhere, SignIns } from "./[id]/family-parts";

// The Families pages with no books (stage 5's slice P2, docs/superpowers/specs/2026-11-28-accounting-plugin-design.md
// section 2): the roster and a family's page drawn from the portal's own records, with nothing from any books. Staff
// who may change families add a family, add a student, rename, move a student and make either inactive, and add and
// remove guardians; each saves at once and sends nothing. The roster tag is "none": no books' company is read.
const NO_BOOKS = "none";

/** Whether a record is active, in words, as a status label. */
const Standing = ({ active }: { active: boolean }) => <StatusBadge tone={active ? "done" : "neutral"}>{active ? "Active" : "Inactive"}</StatusBadge>;

/** The roster with no books: every family, a search, and adding a family. */
export async function FamiliesByHand({ ctx, typed }: { ctx: StaffCtx; typed: string }) {
  const q = typed.toLowerCase();
  const families = await listFamilies();
  const rows = families.filter((f) => !q || f.name.toLowerCase().includes(q)); // a plain substring: nothing typed is a pattern
  const mayAdd = can(ctx.effective, "Roster.Family.ReadWrite");
  const columns: Column<FamilyRow>[] = [
    { key: "name", header: "Family", rowHeader: true, sorted: "ascending", cell: (r) => <a href={familyPage(r.id)}>{r.name}</a> },
    { key: "students", header: "Students", numeric: true, cell: (r) => r.students },
    { key: "guardians", header: "Guardians", numeric: true, cell: (r) => r.guardians },
    { key: "status", header: "Status", cell: (r) => <Standing active={r.active} /> },
  ];
  const active = families.filter((f) => f.active).length;
  return (
    <main className="wrap single">
      <PageHeader title="Roster" lede="The club's families, with their students and guardians." />
      <Card title="Families" titleId="roster-list-h" description={families.length ? `${active} active ${active === 1 ? "family" : "families"}, ${families.length - active} inactive` : undefined}>
        {families.length > 0 && (
          <form method="get" role="search">
            <Toolbar label="Search the roster">
              <TextInput id="roster-q" label="Find a family" name="q" type="search" defaultValue={typed} autoComplete="off" />
              <Button type="submit" variant="outlined">Find</Button>
            </Toolbar>
          </form>
        )}
        {families.length === 0 ? <EmptyState title="No families yet." />
          : rows.length === 0 ? <Notice tone="info">No family matches &quot;{typed}&quot;.</Notice>
          : <DataTable caption={typed ? <>{rows.length} {rows.length === 1 ? "family" : "families"} matching &quot;{typed}&quot;</> : <>Every family, by name</>}
              columns={columns} rows={rows} rowKey={(r) => String(r.id)} />}
      </Card>
      {mayAdd && (
        <Card title="Add a family" titleId="create-h" description="Add its students and guardians from the family's page once it is saved.">
          <NameForm field="The family's name" label="Add the family" variant="filled" pendingLabel="Saving…" act={createAction.bind(null, NO_BOOKS, "family")} />
        </Card>
      )}
    </main>
  );
}

/**
 * One student's changes, on their row (the owner's rule: a row's main action sits on the row): a Drawer with Rename,
 * Move to another family and Make inactive. Only for an active student of an active family, to staff who may change families.
 */
function StudentChanges({ id, name, families }: { id: string; name: string; families: { id: string; name: string }[] }) {
  return (
    <Drawer param="change-student-here" value={id} label={`Change ${name}`} size="sm">
      <NameForm field="New name" label="Rename" pendingLabel="Renaming…" initial={name} act={renameHereAction.bind(null, NO_BOOKS, "student", id)} />
      {families.length > 0 && <>
        <h3>Move to another family</h3>
        <p className="hint">Completed forms and earned credit stay where they are; unfinished forms start again and places on shifts still to come are given up.</p>
        <MoveForm families={families} act={moveAction.bind(null, NO_BOOKS, id)} />
      </>}
      <DeactivateForm label={`Make ${name} inactive`} warning={`${name} is no longer counted in the family's season.`}
        act={deactivateHereAction.bind(null, NO_BOOKS, "student", id)} />
    </Drawer>
  );
}

/** A family's page with no books: its students, its changes, its sign-ins and its other pages. Null for no family record. */
export async function FamilyByHand({ ctx, familyId }: { ctx: StaffCtx; familyId: AppFamilyId }) {
  const fam = await familyHere(familyId);
  if (!fam) return null;
  // A staff read of family data (spec §5): recorded before anything is shown, naming the app's family.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "family", targetId: String(familyId), ip: ctx.ip });
  const changes = can(ctx.effective, "Roster.Family.ReadWrite") && fam.active;
  const signins = await familySignins(familyId);
  const active = fam.students.filter((s) => s.active);
  const moveTo = changes && active.length ? await moveTargetsHere(familyId) : [];
  return (
    <main className="wrap single">
      <PageHeader title={fam.name} back={{ href: "/staff/roster", label: "Back to the roster" }} lede={fam.active ? undefined : <Standing active={false} />} />
      <Card title="Students" titleId="entry-students-h">
        {fam.students.length === 0 ? <EmptyState title="No students yet." />
          : <DataTable caption="Students" captionHidden rows={fam.students} rowKey={(s) => String(s.id)} columns={[
              { key: "name", header: "Student", rowHeader: true, cell: (s) => s.name },
              { key: "status", header: "Status", cell: (s) => <Standing active={s.active} /> },
              ...(changes ? [{ key: "change", header: "Change", quiet: true, cell: (s: (typeof fam.students)[number]) => (s.active
                ? <StudentChanges id={String(s.id)} name={s.name} families={moveTo} /> : null) }] : []),
            ]} />}
      </Card>
      {changes && <PortalChanges byHand familyId={String(familyId)} name={fam.name} noun="family" unlinked addStudents students={[]} rosterTag={NO_BOOKS} />}
      <SignIns familyId={familyId} signins={signins} links={can(ctx.effective, "Parents.ReadWrite")} changes={can(ctx.effective, "Roster.Family.ReadWrite")} inQuickBooks={null}
        addable={fam.active ? null : "This family is inactive in the portal, so nobody can be added to it."} />
      <Elsewhere familyId={familyId} money={false} buyouts={false}
        season={fam.active && can(ctx.effective, "Season.Progress.Read")} credit={fam.active && can(ctx.effective, "Volunteer.Credit.ReadWrite")} />
    </main>
  );
}
