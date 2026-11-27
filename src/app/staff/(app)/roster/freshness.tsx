import type { RosterPage } from "@/lib/roster/queries";
import { LocalTime } from "@/app/components/local-time";
import { Card, LinkButton, Notice } from "@/app/components/ui";
import { RefreshButton } from "./refresh-button";
import { refreshRosterAction } from "./actions";

/** Who can fix a QuickBooks problem: an Admin gets the link, everyone else is told who to ask. */
function WhoCanFix({ admin }: { admin: boolean }) {
  return admin ? <> <LinkButton plain variant="tonal" size="sm" href="/staff/settings/quickbooks">Open QuickBooks settings</LinkButton></> : <> An Admin can reconnect it under QuickBooks.</>;
}

/** Shown on every roster page once a roster exists and QuickBooks has been disconnected (spec §3 Disconnect). */
export function DisconnectedNotice({ page, admin }: { page: RosterPage; admin: boolean }) {
  if (page.connected) return null;
  return (
    <Notice tone="warning">QuickBooks is disconnected, so this roster is no longer current. {page.lastOkAt ? <>It was last read <LocalTime iso={page.lastOkAt} />.</> : "It has never been read."}<WhoCanFix admin={admin} /></Notice>
  );
}

/** When the roster was last read, the latest failure if any, and Refresh now (spec §5 Both). */
export function Freshness({ page, admin }: { page: RosterPage; admin: boolean }) {
  const failed = page.lastRun && !page.lastRun.ok;
  return (
    <Card title="How fresh this is" titleId="roster-fresh-h">
      <p>{page.lastOkAt ? <>Last read from QuickBooks <LocalTime iso={page.lastOkAt} />.</> : "Not read from QuickBooks yet."}{page.connected ? " The worker reads it again every day." : null}</p>
      {failed && <Notice tone="problem" live="none">The latest try failed: {page.lastRun!.detail}<WhoCanFix admin={admin} /></Notice>}
      {page.connected && <RefreshButton refresh={refreshRosterAction} />}
    </Card>
  );
}
