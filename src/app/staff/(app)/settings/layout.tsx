import { requireStaffPage } from "@/lib/guards";
import { integrationItems, railItems, settingsHome, settingsItems, SETTINGS_GROUPS, SETTINGS_ROOT } from "./sections";
import { RAIL_STATUS } from "./statuses";
import { SettingsRail, type RailGroup } from "./settings-rail";

/**
 * Every page under /staff/settings: the rail of what the person may see, each item with its status (read in parallel),
 * beside the page. Like the parent layout it is not a guard: each page keeps requireStaffPage("...") as its first line,
 * and the rail only leaves out what the person may not open. The rail is given names, keywords, addresses and status
 * words, nothing else. On a phone the rail is drawn only at /staff/settings (SettingsRail).
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaffPage();
  const visible = settingsItems(ctx.effective), rail = railItems(ctx.effective);
  if (rail.length === 0) return <>{children}</>;
  const statuses = await Promise.all(rail.map((i) => RAIL_STATUS[i.key](visible)));
  const groups: RailGroup[] = SETTINGS_GROUPS.map((label) => ({
    label,
    entries: rail.flatMap((i, n) => (i.group === label ? [{ key: i.key, title: i.title, href: i.href, owns: [...i.owns], keywords: [...i.keywords], status: statuses[n]! }] : [])),
  })).filter((g) => g.entries.length > 0);
  const extras = integrationItems(ctx.effective).map((i) => ({ key: i.key, title: i.title, href: i.href, keywords: [...i.keywords] }));
  return (
    <div className="settings-layout">
      <SettingsRail groups={groups} extras={extras} overview={settingsHome(ctx.effective) === SETTINGS_ROOT} />
      {children}
    </div>
  );
}
