import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { listPeople, type PersonRow } from "@/lib/parents/directory";
import { getParentSettings } from "@/lib/parents/settings";
import { factorCounts, type FactorCounts } from "@/lib/parents/switches";
import { can } from "@/lib/permissions/effective";
import { Button, Card, DataTable, EmptyState, LocalTime, Notice, PageHeader, StateWords, StatusBadge, TextInput, Toolbar } from "@/app/components/ui";
import { accessTone } from "./access-state";

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
        : p.families.map((f) => <span key={f.guardianId} className="t-line">{f.familyName}: <StatusBadge tone={accessTone(f.kind, p.hasPassword)}>{f.words}</StatusBadge></span>)) },
    ]} />
  );
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * How many of the people who can sign in have a second step of their own (section 9 of the app-owned families spec,
 * "Sign-in"; the sign-in release's slice SI-10b): counts only, naming nobody, so showing them writes no audit row. An
 * Admin is told where the level is chosen.
 */
function FactorLine({ c, strict, admin, signinOn }: { c: FactorCounts; strict: boolean; admin: boolean; signinOn: boolean }) {
  const who = signinOn ? "who can sign in" : "who could sign in once sign-ins are on";
  const counts = `Of the ${n(c.people, "person", "people")} ${who}, ${n(c.passkey, "has", "have")} a passkey and ${c.app} an authenticator app (someone with both is counted twice); ${n(c.neither, "has", "have")} neither.`;
  const level = strict ? " The club is at Strict: anyone with neither adds one the next time they sign in."
    : admin ? " You can ask everyone for one under Settings, Parent sign-ins, step 3, once most have one." : "";
  return <Notice tone="info" live="none">{counts}{level}</Notice>;
}

export default async function ParentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Parents.ReadWrite");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : "").slice(0, 100);
  const [people, settings, factors] = await Promise.all([listPeople(typed), getParentSettings(), factorCounts()]);
  return (
    <main className="wrap single">
      <PageHeader title="Parents" lede="Everyone who can sign in, or once could, and their families. A change in QuickBooks never gives or ends a sign-in." />
      {!settings.signin && <Notice tone="warning">Parent sign-ins are off, so nobody can sign in. An Admin turns them on under Parent sign-ins.</Notice>}
      <FactorLine c={factors} strict={settings.level === "strict"} admin={can(ctx.effective, "Settings.Parents.ReadWrite")} signinOn={settings.signin} />

      <Card title="People" titleId="people-h">
        <form method="get" role="search">
          <Toolbar label="Search the parents">
            <TextInput id="parents-q" label="Find a person by name or email" name="q" type="search" defaultValue={typed} autoComplete="off" />
            <Button type="submit" variant="secondary">Find</Button>
          </Toolbar>
        </form>
        {people.length === 0 ? (typed ? <Notice tone="info">Nobody matches.</Notice> : <EmptyState title="Nobody yet." />) : <People people={people} typed={typed} />}
      </Card>
    </main>
  );
}
