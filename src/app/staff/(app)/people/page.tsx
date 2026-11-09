import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { listStaff, listRoles } from "@/lib/staff/roles";
import { InviteForm, PersonRow } from "./people-client";

export default async function PeoplePage() {
  const ctx = await requireStaffPage("Staff.Users.Read");
  const [people, roles] = await Promise.all([listStaff(), listRoles()]);
  const canEdit = can(ctx.effective, "Staff.Users.ReadWrite");
  const options = roles.map((r) => ({ id: r.id, name: r.name, admin: r.key === "admin" }));
  return (
    <main className="wrap single">
      <h1 className="page-title">Staff</h1>
      <section className="box" aria-labelledby="staff-h">
        <h2 id="staff-h">People who sign in as staff</h2>
        <ul className="lines">{people.map((p) => <PersonRow key={p.id} person={p} roles={options} canEdit={canEdit} />)}</ul>
      </section>
      {canEdit && <section className="box" aria-labelledby="invite-h"><h2 id="invite-h">Add someone</h2>
        <p>They sign in with their Microsoft or Google account using this email.</p><InviteForm roles={options} /></section>}
    </main>
  );
}
