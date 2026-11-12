// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadRosterPage, entryFrom } from "@/lib/roster/queries";
import { familySignins, type FamilySignin } from "@/lib/parents/directory";
import { DisconnectedNotice, Freshness } from "../freshness";
import type { Cust } from "@/lib/roster/model";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

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

/** `detailed` is for staff with `Parents.ReadWrite`: only they see which other family a held address is under, and get links to people. */
function SignIns({ signins, detailed }: { signins: FamilySignin[]; detailed: boolean }) {
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>Who can sign in to the portal for this QuickBooks customer, and why someone can&apos;t.</p>
      {signins.length === 0 ? <p>Nobody can sign in for it yet.</p> : <ul className="lines">{signins.map((s) => (
        <li key={`${s.parentId ?? "none"}|${s.sourceQboId ?? "none"}|${s.email ?? ""}`}><div>
          {detailed && s.parentId ? <Link className="what" href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : <span className="what">{s.name}</span>}
          <span className="when">{s.email ? `${s.email} · ` : ""}{s.words}</span>
        </div></li>))}</ul>}
    </section>
  );
}

export default async function RosterEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const { id } = await params;
  let qboId: string;
  try { qboId = decodeURIComponent(id); } catch { notFound(); }
  const page = await loadRosterPage(); // one load, so the entry and the freshness notes describe the same snapshot
  const entry = entryFrom(page, qboId);
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  if (!entry) notFound();
  // A staff read of family data (spec §5): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "qbo_customer", targetId: qboId, ip: ctx.ip });
  const detailed = can(ctx.effective, "Parents.ReadWrite");
  const signins = await familySignins(qboId, { detailed });
  const customer = entry.kind === "family" ? entry.family.customer : entry.member;
  return (
    <main className="wrap single">
      <h1 className="page-title">{customer.displayName}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"} as QuickBooks lists it{customer.active ? "" : ". It is inactive in QuickBooks"}. <Link href="/staff/roster">Back to the roster</Link></p>
      <DisconnectedNotice page={page} admin={admin} />
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" people={entry.family.students} contact={false} empty="QuickBooks lists no students under this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" people={entry.family.parents} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" people={[entry.member]} contact empty="" />
      )}
      <SignIns signins={signins} detailed={detailed} />
      <Freshness page={page} admin={admin} />
    </main>
  );
}
