import type { ReactNode } from "react";
import type { Effective } from "@/lib/permissions/effective";
import { PageHeader } from "@/app/components/ui";
import { settingsHome, SETTINGS_ROOT } from "./sections";

/** Whether the way back to Settings is drawn: left out for someone who may not open the Overview, so it never leads to a refusal. */
const backTo = (e: Effective) => (settingsHome(e) === SETTINGS_ROOT ? { href: SETTINGS_ROOT, label: "Settings" } : undefined);

/**
 * The way back from a settings page with no head of its own (the design system, a part's sub-page) to Settings, above
 * its title: on a phone only, where the rail isn't drawn beside the page. Given the reader's permissions, from the
 * page's own guard.
 */
export function BackToSettings({ effective }: { effective: Effective }) {
  if (!backTo(effective)) return null;
  return <p className="back-to-settings phone-only"><a href={SETTINGS_ROOT}>Back to Settings</a></p>;
}

/**
 * A settings page's head: PageHeader with "Settings" as the way back, drawn on a phone only (from 760px the rail is
 * beside the page, and the back line's room is kept so every title stands at the same height), and left out for
 * someone who may not open the Overview. Given the reader's permissions, from the page's own guard.
 */
export function SettingsHeader({ effective, title, lede, actions }: { effective: Effective; title: string; lede?: ReactNode; actions?: ReactNode }) {
  return <PageHeader className="settings-head" back={backTo(effective)} title={title} lede={lede} actions={actions} />;
}
