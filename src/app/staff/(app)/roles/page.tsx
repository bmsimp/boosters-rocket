import { requireStaffPage } from "@/lib/guards";
import { listRoles } from "@/lib/staff/roles";
import { GRANTABLE } from "@/lib/permissions/registry";
import { RoleForm } from "./role-form";

export default async function RolesPage() {
  await requireStaffPage("Admin.Roles.ReadWrite");
  const roles = await listRoles();
  return (
    <main className="wrap single">
      <h1 className="page-title">Roles</h1>
      <p className="lede">A role is a list of permissions to include and exclude. Exclude always wins. Admin always has everything. Managing roles, adding staff, changing a person&apos;s roles, turning sign-in on or off, the sign-in, mail, QuickBooks and parent sign-in settings, the audit log and the health page are Admin only, so a role can&apos;t include them. The audit log is Admin only because its rows hold notes that staff write about parents.</p>
      {roles.map((r) => (
        <section className="box" key={r.id} aria-labelledby={`role-${r.id}`}>
          <h2 id={`role-${r.id}`}>{r.name}</h2>
          <p>{r.members} {r.members === 1 ? "person" : "people"}</p>
          {r.builtin ? <p>Holds every permission. Can&apos;t be changed or deleted.</p> : <RoleForm role={r} />}
        </section>
      ))}
      <section className="box" aria-labelledby="new-role"><h2 id="new-role">New role</h2><RoleForm /></section>
      <details className="box"><summary>All permissions</summary>
        <p>A role can name any of these exactly as written, or use <code>*</code> for a part: <code>Roster.*</code> also takes in roster permissions added later.</p>
        <ul>{GRANTABLE.map((p) => <li key={p}><code>{p}</code></li>)}</ul></details>
    </main>
  );
}
