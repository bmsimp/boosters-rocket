import { requireStaffPage } from "@/lib/guards";
import { Card, KeyValue, LinkButton, LocalTime, Notice, PageHeader, StatusBadge, StatusDot } from "@/app/components/ui";
import { integrationItems, railItems, settingsItems } from "./sections";
import { integrationRows, systemStatus, type Status } from "./statuses";
import { overviewCards, type Fact, type OverviewCard } from "./overview";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Settings' Overview, beside the list pane (layout.tsx): a short notice naming what needs attention, each a link to
 * it, then a status card for each area the person may open (overview.ts), as the list pane mirrors them. A card that
 * needs attention has a filled button, the others a tonal one. An integration needing attention is named itself (its
 * row of the Integrations page), not Integrations. Nothing here is a form, and no secret is read.
 *
 * The guard is the Club's read, held by everyone who may see any Settings item but Staff alone (Settings is then their
 * menu's way straight to Staff: settingsHome()). Every other item is Admin only (tests/unit/settings-sections.test.ts).
 */
export default async function SettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const visible = settingsItems(ctx.effective);
  const [cards, rows] = await Promise.all([overviewCards(railItems(ctx.effective), visible), integrationRows(integrationItems(ctx.effective))]);
  const signIn = rows.filter((r) => r.item === "sign-in");
  const nobody = signIn.length > 0 && systemStatus(signIn).words === "Nobody can sign in" ? systemStatus(signIn) : null;
  const attention: { key: string; title: string; href: string; status: Status }[] = [
    ...cards.flatMap((c) => (c.key !== "integrations" && c.status.tone === "due" ? [{ key: c.key, title: c.title, href: c.href, status: c.status }] : [])),
    ...rows.filter((r) => r.status.tone === "due" && !(nobody && r.item === "sign-in")).map((r) => ({ key: r.key, title: r.name, href: r.href, status: r.status })),
    // While nobody can sign in as staff, that is one thing to see to, not one for each provider.
    ...(nobody ? [{ key: "sign-in", title: "Staff sign-in", href: "/staff/settings/sign-in", status: nobody }] : []),
  ];
  return (
    <main className="wrap single settings-overview">
      <PageHeader sample title="Overview" lede="How the portal is set up. Each card says what is set and whether it works." />
      {attention.length === 0 ? <Notice tone="done">Everything that is set up is working.</Notice> : (
        <Notice tone="warning" title="Needs attention" titleId="settings-attention-h">
          <ul className="notice-list">
            {attention.map((a) => <li key={a.key}><a className="link-line" href={a.href} data-attention={a.key}>{`${a.title}: ${a.status.words}`}</a></li>)}
          </ul>
        </Notice>
      )}
      <div className="overview-cards">
        {cards.map((c) => <StatusCard key={c.key} card={c} />)}
      </div>
    </main>
  );
}

function factValue(f: Fact) {
  if (f.at) return <LocalTime iso={f.at} />;
  return <>{f.swatch && <span className="overview-swatch" aria-hidden="true" />}{f.text}</>;
}

/** One area's card: its status in words with its icon, its facts, and the one button that opens it. */
function StatusCard({ card }: { card: OverviewCard }) {
  const due = card.status.tone === "due";
  return (
    <Card title={card.title} titleId={`overview-${card.key}-h`}
      actions={<LinkButton href={card.href} variant={due ? "filled" : "tonal"}>{card.button}</LinkButton>}>
      <p data-card-status={card.status.tone}><StatusBadge tone={card.status.tone}>{card.status.words}</StatusBadge></p>
      {card.systems && card.systems.length > 0 && (
        <ul className="overview-systems" aria-label="Each system">
          {card.systems.map((s) => <li key={s.key}><span>{s.name}</span><StatusDot tone={s.status.tone} words={s.status.words} /></li>)}
        </ul>
      )}
      {card.facts.length > 0 && <KeyValue items={card.facts.map((f) => ({ key: f.key, label: f.label, value: factValue(f) }))} />}
    </Card>
  );
}
