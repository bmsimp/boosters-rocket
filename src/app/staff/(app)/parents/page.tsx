import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { listPeople, type PersonRow } from "@/lib/parents/directory";
import { getParentSettings } from "@/lib/parents/settings";
import { factorCounts, type FactorCounts } from "@/lib/parents/switches";
import { can } from "@/lib/permissions/effective";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";

export const metadata = { title: "Parents" };
export const dynamic = "force-dynamic";

/** Everyone the portal knows, a row each: who, their address, when they last signed in, their welcome, and each family. */
function People({ people, typed }: { people: PersonRow[]; typed: string }) {
  return (
    <DataTable caption={typed ? <>{people.length} matching &quot;{typed}&quot;</> : "Everyone, by name"} rows={people} rowKey={(p) => p.parentId} columns={[
      { key: "name", header: "Person", rowHeader: true, sorted: "ascending", cell: (p) => (
        <><Link href={`/staff/parents/${p.parentId}`}>{p.name}</Link>{p.blocked && <StateWords state="waived" words="Blocked" />}</>) },
      { key: "email", header: "Email", cell: (p) => p.email },
      { key: "signin", header: "Last signed in", cell: (p) => (p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never") },
      { key: "welcome", header: "Welcome email", cell: (p) => (p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} /></> : "Not sent yet") },
      // Family names are text here, never links: a previous company's row carries that company's ID.
      { key: "families", header: "Families", cell: (p) => (p.families.length === 0 ? "No families"
        : p.families.map((f) => <span key={f.guardianId} className="t-line">{f.familyName}: {f.words}</span>)) },
    ]} />
  );
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * How many of the people who can sign in have a second step of their own (section 9 of the app-owned families spec,
 * "Sign-in"; the sign-in release's slice SI-10b): counts only, naming nobody, so showing them writes no audit row. An
 * Admin is told where the level is chosen.
 */
function FactorLine({ c, strict, admin }: { c: FactorCounts; strict: boolean; admin: boolean }) {
  const counts = `Of the ${n(c.people, "person", "people")} who can sign in, ${n(c.passkey, "has", "have")} a passkey and ${c.app} an authenticator app (someone with both is counted twice); ${n(c.neither, "has", "have")} neither.`;
  const level = strict ? " The club is at Strict: anyone with neither adds one the next time they sign in."
    : admin ? " You can ask everyone for one under Settings, Parent sign-ins, step 3, once most have one." : "";
  return <p>{counts}{level}</p>;
}

export default async function ParentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Parents.ReadWrite");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : "").slice(0, 100);
  const [people, settings, factors] = await Promise.all([listPeople(typed), getParentSettings(), factorCounts()]);
  return (
    <main className="wrap single">
      <h1 className="page-title">Parents</h1>
      <p className="lede">Everyone who can sign in to the portal, or once could, and each family they belong to. Who can sign in is kept by the portal itself: a change made in QuickBooks no longer gives anyone a sign-in or ends one.</p>
      {!settings.signin && <Notice tone="warning">Parent sign-ins are off, so nobody can sign in, not even a guardian added here. An Admin switches them on under Parent sign-ins.</Notice>}
      <FactorLine c={factors} strict={settings.level === "strict"} admin={can(ctx.effective, "Settings.Parents.ReadWrite")} />

      <section className="box" aria-labelledby="people-h"><h2 id="people-h">People</h2>
        <form method="get" role="search" className="stack">
          <label className="field"><span>Find a person by name or email</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
          <button className="btn btn-line">Find</button>
        </form>
        {people.length === 0 ? <Notice tone="info">{typed ? "Nobody matches." : "Nobody yet."}</Notice> : <People people={people} typed={typed} />}
      </section>
    </main>
  );
}
