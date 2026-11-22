import type { ReactNode } from "react";
import { requireStaffPage } from "@/lib/guards";
import { PageHeader } from "@/app/components/ui";
import { settingsHome, SETTINGS_ROOT } from "./sections";

/**
 * The way back from a settings page to Settings, above its title: on a phone only, where the rail isn't drawn beside
 * the page. Left out for someone who may not open the Overview (who reached their one item straight from the menu),
 * so it never leads to a refusal.
 */
export async function BackToSettings() {
  const ctx = await requireStaffPage();
  if (settingsHome(ctx.effective) !== SETTINGS_ROOT) return null;
  return <p className="back-to-settings"><a href={SETTINGS_ROOT}>Back to Settings</a></p>;
}

/**
 * A settings page's head: PageHeader with "Settings" as the way back, drawn on a phone only (from 760px the rail is
 * beside the page, and the back line's room is kept so every title stands at the same height), and left out for
 * someone who may not open the Overview.
 */
export async function SettingsHeader({ title, lede, actions }: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  const ctx = await requireStaffPage();
  const back = settingsHome(ctx.effective) === SETTINGS_ROOT ? { href: SETTINGS_ROOT, label: "Settings" } : undefined;
  return <PageHeader className="settings-head" back={back} title={title} lede={lede} actions={actions} />;
}
