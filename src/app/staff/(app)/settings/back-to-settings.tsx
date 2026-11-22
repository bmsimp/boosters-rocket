import { requireStaffPage } from "@/lib/guards";
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
