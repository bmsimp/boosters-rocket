import type { RosterPage } from "@/lib/roster/queries";
import { LocalTime } from "@/app/components/local-time";
import { RefreshButton } from "./refresh-button";
import { refreshRosterAction } from "./actions";

/** Shown on every roster page once a roster exists and QuickBooks has been disconnected (spec §3 Disconnect). */
export function DisconnectedNotice({ page }: { page: RosterPage }) {
  if (page.connected) return null;
  return (
    <p role="status">QuickBooks is disconnected, so this roster is no longer current. {page.lastOkAt ? <>It was last read <LocalTime iso={page.lastOkAt} />.</> : "It has never been read."}</p>
  );
}

/** When the roster was last read, the latest failure if any, and Refresh now (spec §5 Both). */
export function Freshness({ page }: { page: RosterPage }) {
  return (
    <section className="box" aria-labelledby="roster-fresh-h"><h2 id="roster-fresh-h">How fresh this is</h2>
      <p>{page.lastOkAt ? <>Last read from QuickBooks <LocalTime iso={page.lastOkAt} />.</> : "Not read from QuickBooks yet."}
        {page.lastRun && !page.lastRun.ok ? <> The latest try failed: {page.lastRun.detail}</> : null} The worker reads it again every day.</p>
      {page.connected && <RefreshButton refresh={refreshRosterAction} />}
    </section>
  );
}
