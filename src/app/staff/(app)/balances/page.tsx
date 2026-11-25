import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { formatMoney } from "@/lib/money/cents";
import { loadBalances, SEARCH_MAX, type BalanceRow } from "@/lib/money/balances";
import { moneyRunView, type MoneyRunView } from "@/lib/money/sweep";
import { Button, CalendarDate, Card, Checkbox, DataTable, EmptyState, LinkButton, LocalTime, Notice, PageHeader, TextInput, Toolbar } from "@/app/components/ui";
import { familyBalancePage } from "@/app/staff/(app)/family-pages";
import { OneButton } from "../seasons/forms";
import { askForMoneyRunAction } from "./actions";
import { WorthALook } from "./worth-a-look";

export const metadata = { title: "Balances" };
export const dynamic = "force-dynamic";

const familiesWord = (n: number) => `${n} ${n === 1 ? "family" : "families"}`;

/**
 * The read of every family from QuickBooks, said in the page's lede: under way, asked for, or when it last finished. Its
 * press, "Read every family now", is the page's action (RunPress) while neither is so.
 */
function RunWords({ run }: { run: MoneyRunView }) {
  return run.running
    ? <>Reading every family now: {familiesWord(run.running.read)} read so far{run.running.failed ? `, ${run.running.failed} couldn't be read` : ""}. Started <LocalTime iso={run.running.startedAt} />.</>
    : run.asked ? <>A read of every family is asked for. The worker starts it within a minute.</>
    : run.last ? <>Every family was last read <LocalTime iso={run.last.finishedAt} />{run.last.ok ? "" : ", part way"}{run.last.detail ? `: ${run.last.detail}` : "."}</>
    : <>Every family hasn&apos;t been read in one go yet.</>;
}

/** The families, one row each: what is open, when it was read, and what is owed, in one right-aligned column. */
function FamilyTable({ rows, caption }: { rows: BalanceRow[]; caption: string }) {
  return (
    <DataTable caption={caption} rows={rows} rowKey={(r) => r.familyQboId} columns={[
      { key: "name", header: "Family", rowHeader: true, cell: (r) => (r.familyId === null ? r.name : <Link href={familyBalancePage(r.familyId)}>{r.name}</Link>) },
      { key: "open", header: "Open invoices", cell: (r) => (r.figures === null ? (r.familyId === null ? "No family in the portal" : "Not read from QuickBooks yet") : r.figures.openCount === 0 ? "Nothing owed"
        : <>{r.figures.openCount === 1 ? "1 open invoice" : `${r.figures.openCount} open invoices`}{r.figures.oldestDue && <>, oldest due <CalendarDate iso={r.figures.oldestDue} /></>}</>) },
      { key: "read", header: "Read from QuickBooks", cell: (r) => (
        <>{r.figures ? <LocalTime iso={r.figures.readAt} /> : "Never"}{r.failedAt && <span className="when">The last try to read it didn&apos;t work (<LocalTime iso={r.failedAt} />)</span>}</>) },
      { key: "owed", header: "Owed", numeric: true, cell: (r) => (
        <span className="amount">{r.figures === null ? "" : r.figures.currency === null ? "More than one currency" : formatMoney(r.figures.totalCents, r.figures.currency)}</span>) },
    ]} />
  );
}

export default async function BalancesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Finance.Balance.Read");
  const sp = await searchParams;
  const owing = sp.owing === "1";
  const search = typeof sp.q === "string" ? sp.q.slice(0, SEARCH_MAX) : "";
  // A staff read of family data (v1 spec §13): every family's balance, recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "money.balances.read", permission: "Finance.Balance.Read",
    targetType: "family_money", ip: ctx.ip, after: { onlyOwing: owing, search: search || null } });
  const [balances, run] = await Promise.all([loadBalances({ owing, search }), moneyRunView()]);
  const filtered = owing || search !== "";
  // Families with no link have no row (stage 4's slice M3b): one line counts them, pointing at where they are linked.
  const mayLink = can(ctx.effective, "Accounting.Link.ReadWrite") && can(ctx.effective, "Roster.Read");
  return (
    <main className="wrap single">
      <PageHeader title="Balances"
        lede={<>What each family owes, from the figures QuickBooks last gave. Opening this page asks QuickBooks nothing. The worker reads every family&apos;s invoices once a day, and a parent opening their page reads theirs again. <RunWords run={run} /></>}
        actions={!run.running && !run.asked && <OneButton label="Read every family now" pendingLabel="Asking…" act={askForMoneyRunAction} />} />

      <Card title="Families" titleId="families-h">
        {balances.unlinked > 0 && <Notice tone="info" live="none">{balances.unlinked === 1 ? "1 family isn't" : `${balances.unlinked} families aren't`} linked to the books, so {balances.unlinked === 1 ? "it has" : "they have"} no figures here.
          {" "}{mayLink ? <LinkButton variant="secondary" size="sm" href="/staff/links">{balances.unlinked === 1 ? "Link it" : "Link them"} on Accounting links</LinkButton> : `Someone who can link families links ${balances.unlinked === 1 ? "it" : "them"} on Accounting links.`}</Notice>}
        <form method="get" action="/staff/balances">
          <Toolbar label="Filter the families">
            <TextInput id="balances-q" label="Find a family or a student" name="q" type="search" maxLength={SEARCH_MAX} defaultValue={search} />
            <fieldset className="checks"><legend>Which families</legend>
              <Checkbox id="balances-owing" name="owing" value="1" defaultChecked={owing} label=" Only families that owe something" /></fieldset>
            <Button type="submit" variant="secondary">Show</Button>
            {filtered && <LinkButton variant="quiet" href="/staff/balances">Show every family</LinkButton>}
          </Toolbar>
        </form>
        {!balances.roster ? <Notice tone="warning">The roster can&apos;t be shown right now. The Roster page says why.</Notice>
          : balances.rows.length === 0 ? (filtered ? <Notice tone="info">No family matches.</Notice> : <EmptyState title="There are no families on the roster." />)
          : <FamilyTable rows={balances.rows} caption={`${filtered ? `${balances.rows.length} of ${familiesWord(balances.families)}` : familiesWord(balances.families)}, by name.`} />}
      </Card>

      {balances.worthALook.length > 0 && (
        <Card title="Worth a look" titleId="look-h"
          description={<>QuickBooks&apos; balance for these customers doesn&apos;t match their open invoices. It may be a credit, an unapplied payment, or a charge that isn&apos;t an invoice. Parents see the invoices.</>}>
          <WorthALook rows={balances.worthALook} />
        </Card>
      )}
    </main>
  );
}
