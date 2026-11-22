import { requireStaffPage } from "@/lib/guards";
import { Card, List, ListRow, Notice, PageHeader } from "@/app/components/ui";
import { integrationItems, railItems, settingsItems } from "./sections";
import { RAIL_STATUS, integrationRows, systemStatus, type Status } from "./statuses";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Settings' Overview, beside the rail (layout.tsx): what needs attention, each a row that leads to it, or one done
 * notice. The rail above it (the first screen on a phone) holds every item with its status; this says which to open
 * first. An integration needing attention is named itself (its row of the Integrations page), not Integrations. Nothing
 * here is a form, and no secret is read.
 *
 * The guard is the Club's read, held by everyone who may see any Settings item but Staff alone (Settings is then their
 * menu's way straight to Staff: settingsHome()). Every other item is Admin only (tests/unit/settings-sections.test.ts).
 */
export default async function SettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const visible = settingsItems(ctx.effective);
  const pages = railItems(ctx.effective).filter((i) => i.key !== "integrations");
  const [statuses, rows] = await Promise.all([Promise.all(pages.map((i) => RAIL_STATUS[i.key](visible))), integrationRows(integrationItems(ctx.effective))]);
  const signIn = rows.filter((r) => r.item === "sign-in");
  const nobody = signIn.length > 0 && systemStatus(signIn).words === "Nobody can sign in" ? systemStatus(signIn) : null;
  const attention: { key: string; title: string; href: string; status: Status }[] = [
    ...pages.flatMap((i, n) => (statuses[n]!.tone === "due" ? [{ key: i.key, title: i.title, href: i.href, status: statuses[n]! }] : [])),
    ...rows.filter((r) => r.status.tone === "due" && !(nobody && r.item === "sign-in")).map((r) => ({ key: r.key, title: r.name, href: r.href, status: r.status })),
    // While nobody can sign in as staff, that is one thing to see to, not one for each provider.
    ...(nobody ? [{ key: "sign-in", title: "Staff sign-in", href: "/staff/settings/sign-in", status: nobody }] : []),
  ];
  return (
    <main className="wrap single settings-overview">
      <PageHeader sample title="Overview" lede="How the portal is set up. Each item in the list says whether it works. Open one to set it up or change it." />
      {attention.length === 0 ? <Notice tone="done">Everything that is set up is working.</Notice> : (
        <Card title="Needs attention" titleId="settings-attention-h">
          <List>
            {attention.map((a) => <ListRow key={a.key} href={a.href} status={{ tone: "due" }} title={a.title} meta={a.status.words} data-attention={a.key} />)}
          </List>
        </Card>
      )}
    </main>
  );
}
