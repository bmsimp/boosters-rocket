import { requireStaffPage } from "@/lib/guards";
import { listRoles } from "@/lib/staff/roles";
import { checklistView } from "@/lib/permissions/checklist";
import { ADMIN_ONLY_WORDS } from "@/lib/permissions/words";
import { DeleteRole, RoleForm } from "./role-form";

import { SettingsHeader } from "../back-to-settings";

export const metadata = { title: "Roles" };

const people = (n: number) => (n === 0 ? "Nobody holds this role yet." : `${n} ${n === 1 ? "person holds" : "people hold"} this role.`);

export default async function RolesPage() {
  await requireStaffPage("Admin.Roles.ReadWrite");
  const roles = await listRoles();
  return (
    <main className="wrap single roles-page">
      <SettingsHeader title="Roles" lede="A role is a set of things staff may do. Tick what each role lets its people do, then save. A person can hold more than one role, and gets everything their roles give." />
      <details className="box"><summary>What only an Admin can do</summary>
        <p>The Admin role holds everything. These are kept for Admins alone, so no other role can be given them. The audit log is one, because its rows hold notes staff write about parents.</p>
        <ul>{ADMIN_ONLY_WORDS.map((w) => <li key={w}>{w}</li>)}</ul>
      </details>
      {roles.map((r) => (
        <section className="box" key={r.id} aria-labelledby={`role-${r.id}`}>
          <h2 id={`role-${r.id}`}>{r.name}</h2>
          <p>{people(r.members)}</p>
          {r.builtin ? <p>Holds every permission, the Admin-only ones too. It can&apos;t be changed or deleted.</p> : (
            <>
              <RoleForm role={{ id: r.id, name: r.name, members: r.members, ...checklistView({ include: r.include, exclude: r.exclude }) }} />
              <DeleteRole role={{ id: r.id, name: r.name, members: r.members }} />
            </>
          )}
        </section>
      ))}
      <section className="box" aria-labelledby="new-role"><h2 id="new-role">New role</h2><RoleForm /></section>
    </main>
  );
}
