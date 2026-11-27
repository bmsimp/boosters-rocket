import { requireStaffPage } from "@/lib/guards";
import { backupsView, readyDownload, scheduleWords, sizeWords, stampIso, type BackupRow } from "@/lib/backups/status";
import { readOffsite } from "@/lib/backups/offsite";
import { Card, ConfirmDialog, DataTable, Drawer, EmptyState, KeyValue, LinkButton, LocalTime, Notice, StateWords, type Column } from "@/app/components/ui";
import { SettingsHeader } from "../back-to-settings";
import { OffsiteForm, PressButton, RefreshWhileBusy, RowActions, ScheduleForm } from "./forms";
import { backUpNowAction, prepareDownloadAction, restoreBackupAction, saveOffsiteAction, saveScheduleAction, stopOffsiteAction, testOffsiteAction } from "./actions";

export const metadata = { title: "Backups" };
export const dynamic = "force-dynamic";

/**
 * Settings, Backups (docs/superpowers/specs/2026-11-28-in-app-backups-design.md, section 5): the backups the server
 * holds, Back up now, the schedule, a download, a restore, and off-site copies. Admin only (Admin.Backups.ReadWrite):
 * a backup holds every family's records. The work is the backup service's on the server; this page asks, and shows what
 * it last said. It shows no family's data, so opening it is not audited.
 */
export default async function BackupsPage() {
  const ctx = await requireStaffPage("Admin.Backups.ReadWrite");
  const [v, offsite, ready] = await Promise.all([backupsView(), readOffsite(), readyDownload(ctx.staffUserId)]);
  const backingUp = v.waiting.find((w) => w.kind === "backup");
  const restoring = v.waiting.find((w) => w.kind === "restore");
  const preparing = v.waiting.find((w) => w.kind === "download");
  const failedLast = v.lastBackupRequest && v.lastBackupRequest.outcome !== "ok" && (!v.last || Date.parse(v.lastBackupRequest.finishedAt) > Date.parse(v.last.at)) ? v.lastBackupRequest : null;
  const restoreNews = v.lastRestore;
  const newest = v.rows[0] ?? null;
  const busy = v.answering && Boolean(backingUp || restoring || preparing);

  const columns: Column<BackupRow>[] = [
    { key: "when", header: "Made", rowHeader: true, sorted: "descending", cell: (r) => <LocalTime iso={r.iso} /> },
    { key: "size", header: "Size", numeric: true, cell: (r) => sizeWords(r.portalBytes + (r.documensoBytes ?? 0)) },
    { key: "documenso", header: "Documenso", cell: (r) => (r.documensoBytes !== null ? "Included" : "Left out") },
    ...(offsite ? [{ key: "offsite", header: "Off-site copy", cell: (r: BackupRow) => (!r.offsite ? "Not copied" : r.offsite.ok ? "Copied" : "Failed") }] : []),
    ...(v.answering ? [{ key: "actions", header: "Actions", quiet: true, cell: (r: BackupRow) => (
      <>
        <RowActions iso={r.iso} restorable={r.restorable} download={prepareDownloadAction.bind(null, r.backupAt)} restore={restoreBackupAction.bind(null, r.backupAt)} />
        {!r.restorable && <span className="when">Made by another version of the portal: put back with the restore runbook.</span>}
      </>) }] : []),
  ];

  return (
    <main className="wrap single">
      <RefreshWhileBusy busy={busy} />
      <SettingsHeader effective={ctx.effective} title="Backups" lede="Copies of the club's records, made on the server every night." />

      {!v.answering && (
        <Notice tone="warning">
          The backup service on the server isn&apos;t answering, so backups can&apos;t be managed here. The person who looks after the server can check it.
          {v.beat && <> It last answered <LocalTime iso={v.beat.at} />.</>}
        </Notice>
      )}
      {restoring && <Notice tone="info">Putting back the backup from <LocalTime iso={stampIso(restoring.backupAt ?? "")} />. You may need to sign in again when it is done.</Notice>}
      {restoreNews && (restoreNews.outcome === "ok"
        ? <Notice tone="done">Put back the backup from <LocalTime iso={stampIso(restoreNews.backupAt ?? "")} />{typeof restoreNews.result.backupMadeFirst === "string" ? <>. The backup made just before, at <LocalTime iso={stampIso(String(restoreNews.result.backupMadeFirst))} />, is in the list</> : null}.</Notice>
        : <Notice tone="problem">The backup wasn&apos;t put back. {restoreNews.words}</Notice>)}
      {ready && (
        <Notice tone="done">
          Your download is ready for 15 minutes{ready.bytes !== null ? ` (${sizeWords(ready.bytes)})` : ""}. It can be saved once.
          <div><LinkButton plain href={`/staff/settings/backups/download?id=${ready.id}`}>Save the backup file</LinkButton></div>
        </Notice>
      )}
      {preparing && <Notice tone="info">Preparing your download…</Notice>}

      <Card title="Last backup" titleId="backups-last-h">
        <KeyValue items={[
          { key: "last", label: "Last backup", value: v.last ? <LocalTime iso={v.last.at} /> : "None yet" },
          newest && { key: "size", label: "Size", value: sizeWords(newest.portalBytes + (newest.documensoBytes ?? 0)), numeric: true },
          v.beat?.freeBytes != null && { key: "free", label: "Free space on the server", value: sizeWords(v.beat.freeBytes), numeric: true },
          { key: "next", label: "Next backup", value: v.beat?.nextAt ? <LocalTime iso={v.beat.nextAt} /> : v.schedule.at === "off" ? "Not on a schedule" : "Not known yet" },
        ]} />
        {backingUp && <Notice tone="info">Backing up, started <LocalTime iso={backingUp.claimedAt ?? backingUp.requestedAt} />.</Notice>}
        {failedLast && <Notice tone="problem">The last backup failed. {failedLast.words}</Notice>}
        {v.answering && !backingUp && !restoring && <PressButton label="Back up now" busyLabel="Asking…" act={backUpNowAction} />}
      </Card>

      <Card title="Schedule" titleId="backups-schedule-h">
        <p>{scheduleWords(v.schedule)}</p>
        <Drawer param="schedule" label="Change the schedule" description="The backup service uses it from its next look, within a minute.">
          <ScheduleForm at={v.schedule.at} keep={v.schedule.keep} save={saveScheduleAction} />
        </Drawer>
      </Card>

      <Card title="Backups on this server" titleId="backups-list-h">
        {v.rows.length === 0
          ? <EmptyState title="No backups on the server yet">Each one is listed here once it is made.</EmptyState>
          : <DataTable caption="Backups on this server" captionHidden columns={columns} rowKey={(r) => r.backupAt} rows={v.rows} />}
      </Card>

      <Card title="Off-site copies" titleId="backups-offsite-h">
        {offsite ? (
          <>
            <StateWords state="done" words="On: each backup is also copied, encrypted, to your storage" />
            <KeyValue items={[
              { key: "where", label: "Storage", value: `${offsite.endpoint}, bucket ${offsite.bucket}${offsite.folder ? `, folder ${offsite.folder}` : ""}` },
              { key: "copy", label: "Last copy", value: lastCopy(v.rows) },
              offsite.lastTest && { key: "test", label: "Last test", value: <>{offsite.lastTest.ok ? "Worked" : "Failed"}, <LocalTime iso={offsite.lastTest.at} /></> },
            ]} />
            <div className="row-actions">
              <PressButton label="Test the connection" busyLabel="Testing…" variant="tonal" act={testOffsiteAction} />
              <Drawer param="offsite" label="Change off-site storage" description="Each backup is encrypted, then copied there.">
                <OffsiteForm saved={{ endpoint: offsite.endpoint, region: offsite.region, bucket: offsite.bucket, folder: offsite.folder, keyEnd: offsite.keyEnd }} save={saveOffsiteAction} />
              </Drawer>
              <ConfirmDialog label="Stop off-site copies" consequence="Copies already there stay. New backups won't be copied." act={stopOffsiteAction} />
            </div>
          </>
        ) : (
          <>
            <p>Keep a copy away from this server, in S3-compatible storage the club rents. Off until you set it up.</p>
            <Drawer param="offsite" label="Set up off-site copies" variant="tonal" description="Each backup is encrypted, then copied there. You are shown the passphrase once.">
              <OffsiteForm saved={null} save={saveOffsiteAction} />
            </Drawer>
          </>
        )}
      </Card>

      <Card title="Keep these too" titleId="backups-keep-h">
        <p>Keep the server&apos;s env file, and Documenso&apos;s signing certificate with its passphrase, in the board&apos;s password manager. Backups can&apos;t bring the portal back without them.</p>
      </Card>
    </main>
  );
}

function lastCopy(rows: BackupRow[]) {
  const copied = rows.filter((r) => r.offsite).sort((a, b) => b.offsite!.at.localeCompare(a.offsite!.at))[0];
  if (!copied) return "None yet";
  return <>{copied.offsite!.ok ? "Copied" : "Failed"}, <LocalTime iso={copied.offsite!.at} /></>;
}
