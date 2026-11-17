import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { creditFamilies } from "@/lib/volunteer/staff-credit";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";

export const metadata = { title: "Volunteer credit" };
export const dynamic = "force-dynamic";

/**
 * Volunteer credit, by family: every active family on the roster with how many credits it has, each a link to its own
 * page, where staff see and correct its credit. A list of names like the roster's, so opening it is not audited; each
 * family's page is.
 */
export default async function VolunteerCreditPage() {
  await requireStaffPage("Volunteer.Credit.ReadWrite");
  const families = await creditFamilies();
  return (
    <main className="wrap single">
      <h1 className="page-title">Volunteer credit</h1>
      <p className="lede">Check-ins and volunteering done outside the portal, by family. Open a family to see how its credit counts toward each requirement, or to credit something done elsewhere. <Link href="/staff/volunteer">Back to Volunteer</Link></p>
      <section className="box" aria-labelledby="families-h"><h2 id="families-h">Families</h2>
        {families === null ? <Notice tone="warning" live="none">The roster can&apos;t be shown until QuickBooks is connected and the roster has been read.</Notice>
          : families.length === 0 ? <p>There are no active families on the roster.</p> : (
            <DataTable caption="Every active family, by name, with its credit" captionHidden rows={families} rowKey={(f) => f.qboId} columns={[
              { key: "name", header: "Family", rowHeader: true, cell: (f) => <Link href={`/staff/volunteer/credit/${encodeURIComponent(f.qboId)}`}>{f.name}</Link> },
              { key: "credits", header: "Credits", numeric: true, cell: (f) => (f.credits === 0 ? "No credit yet" : `${f.credits} ${f.credits === 1 ? "credit" : "credits"}`) },
            ]} />
          )}
      </section>
    </main>
  );
}
