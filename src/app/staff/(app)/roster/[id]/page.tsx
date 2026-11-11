import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { rosterEntry, loadRosterPage } from "@/lib/roster/queries";
import { DisconnectedNotice, Freshness } from "../freshness";
import type { Cust } from "@/lib/roster/model";
import type { SignIn } from "@/lib/roster/attention";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

const STATUS: Record<SignIn["status"], string> = { invited: "Invited", active: "Active", disabled: "Disabled" };
const inactive = (c: Cust) => (c.active ? "" : " · Inactive in QuickBooks");

function People({ id, title, people, contact, empty }: { id: string; title: string; people: Cust[]; contact: boolean; empty: string }) {
  return (
    <section className="box" aria-labelledby={id}><h2 id={id}>{title}</h2>
      {people.length === 0 ? <p>{empty}</p> : <ul className="lines">{people.map((p) => (
        <li key={p.qboId}><div><span className="what">{p.displayName}</span>
          <span className="when">{contact ? `${p.email ?? "No email address"} · ${p.phone ?? "No phone number"}` : ""}{inactive(p).replace(/^ · /, contact ? " · " : "")}</span></div></li>))}</ul>}
    </section>
  );
}

function SignIns({ signIns }: { signIns: SignIn[] }) {
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>The people who can sign in to the portal for this QuickBooks customer. This comes from the portal, not from QuickBooks.</p>
      {signIns.length === 0 ? <p>Nobody can sign in for it yet.</p> : <ul className="lines">{signIns.map((s) => (
        <li key={s.guardianId}><div><span className="what">{s.name}</span><span className="when">{s.email} · {STATUS[s.status]}</span></div></li>))}</ul>}
    </section>
  );
}

export default async function RosterEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const { id } = await params;
  let qboId: string;
  try { qboId = decodeURIComponent(id); } catch { notFound(); }
  const [entry, page] = await Promise.all([rosterEntry(qboId), loadRosterPage()]);
  if (!entry) notFound();
  // A staff read of family data (spec §5): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "qbo_customer", targetId: qboId, ip: ctx.ip });
  const customer = entry.kind === "family" ? entry.family.customer : entry.member;
  return (
    <main className="wrap single">
      <h1 className="page-title">{customer.displayName}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"} as QuickBooks lists it{customer.active ? "" : ". It is inactive in QuickBooks"}. <Link href="/staff/roster">Back to the roster</Link></p>
      <DisconnectedNotice page={page} />
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" people={entry.family.students} contact={false} empty="QuickBooks lists no students under this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" people={entry.family.parents} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" people={[entry.member]} contact empty="" />
      )}
      <SignIns signIns={entry.signIns} />
      <Freshness page={page} />
    </main>
  );
}
