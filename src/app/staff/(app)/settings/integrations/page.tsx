import type { ReactNode } from "react";
import { requireStaffPage } from "@/lib/guards";
import { Badge, CalendarDate, List, ListRow, StatusDot } from "@/app/components/ui";
import { SettingsHeader } from "../back-to-settings";
import { integrationItems, type IntegrationKey } from "../sections";
import { integrationRows, type IntegrationRow } from "../statuses";
import { IntegrationLogo } from "../integration-logo";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

/** The kinds of system, in the page's order, each with what it is for and its one rule. */
const KINDS: { item: IntegrationKey; id: string; title: string; lede: string; rule: string }[] = [
  { item: "quickbooks", id: "accounting", title: "Accounting", lede: "Where the club's books are. The portal reads families' invoices from it and sends only the changes staff ask for.",
    rule: "One QuickBooks company is connected at a time. Moving to another company is its own step." },
  { item: "forms", id: "forms", title: "Forms and signing", lede: "Where parents sign the club's forms, inside the portal.", rule: "The club's own Documenso, at the address you give." },
  { item: "mail", id: "mail", title: "Outgoing mail", lede: "How sign-in codes, password links, welcome emails and reminders reach parents.", rule: "One way of sending is used at a time." },
  { item: "sign-in", id: "staff-sign-in", title: "Staff sign-in", lede: "How board members and directors sign in. Parents sign in with the portal's own passwords and codes, under Parent sign-ins.",
    rule: "Staff can sign in with either or both." },
];

/** A row's status: its words, or for a credential with a date, the date drawn for the reader ("Certificate expires Dec 2"). */
function RowStatus({ row }: { row: IntegrationRow }): ReactNode {
  if (row.expires) {
    return <span className={`status-dot tone-${row.status.tone}`}><span className="dot" aria-hidden="true" />{row.expires.what} <CalendarDate iso={row.expires.iso} /></span>;
  }
  return <StatusDot tone={row.status.tone} words={row.status.words} />;
}

/**
 * The systems the portal talks to, by kind, each kind with its one rule and a row for each system the person may see:
 * its mark, its name, what the portal does with it, its status, and the way to its own page. Only Admins hold the
 * integration permissions (the spec's decision 2), so the guard is QuickBooks' (decision 4). It shows no family's
 * data, so opening it is not audited.
 */
export default async function IntegrationsPage() {
  const ctx = await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const rows = await integrationRows(integrationItems(ctx.effective));
  return (
    <main className="wrap single integrations-page">
      <SettingsHeader effective={ctx.effective} title="Integrations" lede="The accounting system, forms service, mail service and staff sign-in providers the portal works with. Open one to set it up, change it or check it." />
      {KINDS.map((k) => {
        const mine = rows.filter((r) => r.item === k.item);
        if (mine.length === 0) return null;
        return (
          <section key={k.id} className="integration-kind" aria-labelledby={`kind-${k.id}-h`} data-kind={k.id}>
            <h2 id={`kind-${k.id}-h`}>{k.title}</h2>
            <p className="kind-lede">{k.lede} <span className="kind-rule">{k.rule}</span></p>
            <List label={k.title}>
              {mine.map((r) => (
                <ListRow key={r.key} href={r.href} logo={<IntegrationLogo of={r.key} />} data-integration={r.key}
                  title={<>{r.name}{r.badge && <Badge>{r.badge}</Badge>}</>} meta={r.does} trail={<RowStatus row={r} />} />
              ))}
            </List>
          </section>
        );
      })}
    </main>
  );
}
