import type { RosterPage } from "@/lib/roster/queries";
import { LocalTime } from "@/app/components/local-time";
import { RefreshButton } from "./refresh-button";
import { refreshRosterAction } from "./actions";

/** Who can fix a QuickBooks problem: an Admin gets the link, everyone else is told who to ask. */
function WhoCanFix({ admin }: { admin: boolean }) {
  return admin ? <> <a href="/staff/settings/quickbooks">Open QuickBooks settings</a></> : <> An Admin can reconnect it under QuickBooks.</>;
}

/** Shown on every roster page once a roster exists and QuickBooks has been disconnected (spec §3 Disconnect). */
export function DisconnectedNotice({ page, admin }: { page: RosterPage; admin: boolean }) {
  if (page.connected) return null;
  return (
    <p role="status">QuickBooks is disconnected, so this roster is no longer current. {page.lastOkAt ? <>It was last read <LocalTime iso={page.lastOkAt} />.</> : "It has never been read."}<WhoCanFix admin={admin} /></p>
  );
}

/** When the roster was last read, the latest failure if any, and Refresh now (spec §5 Both). */
export function Freshness({ page, admin }: { page: RosterPage; admin: boolean }) {
  const failed = page.lastRun && !page.lastRun.ok;
  return (
    <section className="box" aria-labelledby="roster-fresh-h"><h2 id="roster-fresh-h">How fresh this is</h2>
      <p>{page.lastOkAt ? <>Last read from QuickBooks <LocalTime iso={page.lastOkAt} />.</> : "Not read from QuickBooks yet."}
        {failed ? <> The latest try failed: {page.lastRun!.detail}<WhoCanFix admin={admin} /></> : null}{page.connected ? " The worker reads it again every day." : null}</p>
      {page.connected && <RefreshButton refresh={refreshRosterAction} />}
    </section>
  );
}
