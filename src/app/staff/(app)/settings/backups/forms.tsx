"use client";
import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionOutcome, Button, Checkbox, ConfirmDialog, LocalTime, TextInput, type Confirmed } from "@/app/components/ui";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

type Done = Confirmed;
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/** One press with its answer drawn in place: Back up now, Test the connection. */
export function PressButton({ label, busyLabel, variant = "filled", act }: { label: string; busyLabel: string; variant?: "filled" | "tonal" | "outlined"; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <div className="stack">
      <ActionOutcome state={state} />
      <div><Button variant={variant} busy={pending} aria-disabled={pending || undefined} onClick={() => { if (!pending) startTransition(() => run()); }}>{pending ? busyLabel : label}</Button></div>
    </div>
  );
}

/** While the backup service works on something, the page reads itself again every few seconds. */
export function RefreshWhileBusy({ busy }: { busy: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [busy, router]);
  return null;
}

/** The schedule's Drawer: a time of day (or none), and how many to keep. */
export function ScheduleForm({ at, keep, save }: { at: string; keep: number; save: (f: FormData) => Promise<Done> }) {
  const [time, setTime] = useState(at === "off" ? "03:00" : at);
  const [off, setOff] = useState(at === "off");
  const [count, setCount] = useState(String(keep));
  const [state, run, pending] = useActionState(async () => {
    const f = new FormData();
    f.set("at", time); f.set("keep", count);
    if (off) f.set("off", "on");
    return safely(() => save(f), failed);
  }, null);
  const fewer = Number(count) < keep;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!pending) startTransition(() => run()); }}>
      <TextInput id="backup-at" label="Time of day" type="time" hint="In the club's time zone (Settings, Club)." value={time} disabled={off} onChange={(e) => setTime(e.target.value)} />
      <Checkbox id="backup-off" label="Don't back up on a schedule" checked={off} onChange={(e) => setOff(e.target.checked)} />
      <TextInput id="backup-keep" label="How many backups to keep" type="number" inputMode="numeric" min={1} max={60} value={count} onChange={(e) => setCount(e.target.value)} />
      {fewer && <p className="hint">Older backups beyond this number are removed after the next backup.</p>}
      <ActionOutcome state={state} />
      <div><Button type="submit" busy={pending} aria-disabled={pending || undefined}>{pending ? "Saving…" : "Save the schedule"}</Button></div>
    </form>
  );
}

/** A row's two presses: Download, and Restore this backup, each behind its ConfirmDialog. */
export function RowActions({ iso, restorable, download, restore }: { iso: string; restorable: boolean; download: () => Promise<Done>; restore: (() => Promise<Done>) | null }) {
  return (
    <div className="row-actions backup-actions">
      <ConfirmDialog label="Download" context={iso} variant="tonal" size="sm" title="Download this backup?" confirmLabel="Prepare the download" busyLabel="Asking…"
        consequence="This file holds every family's records. Keep it private, and delete it when you're done." act={download} />
      {restore && restorable && (
        <ConfirmDialog label="Restore this backup" context={iso} size="sm" busyLabel="Asking…" check="I understand that everything done since then is lost."
          consequence={<>Everything done since <LocalTime iso={iso} /> is lost, and anyone who signed in since then signs in again. A backup of how things are now is made first.</>}
          act={restore} />
      )}
    </div>
  );
}

export type OffsiteSaved = { endpoint: string; region: string; bucket: string; folder: string; keyEnd: string } | null;

/** Off-site storage's Drawer. A saved secret is never sent here: a blank field keeps it. */
export function OffsiteForm({ saved, save }: { saved: OffsiteSaved; save: (f: FormData) => Promise<Done> }) {
  const [v, setV] = useState({ endpoint: saved?.endpoint ?? "", region: saved?.region ?? "auto", bucket: saved?.bucket ?? "", folder: saved?.folder ?? "", accessKeyId: "", secret: "" });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const [state, run, pending] = useActionState(async () => {
    const f = new FormData();
    for (const [k, val] of Object.entries(v)) f.set(k, val);
    const r = await safely(() => save(f), failed);
    if (r.ok) setV((x) => ({ ...x, secret: "" }));
    return r;
  }, null);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!pending) startTransition(() => run()); }}>
      <TextInput id="offsite-endpoint" label="Storage address" hint="The S3 address your storage gives, such as https://storage.example.com." inputMode="url" autoComplete="off" spellCheck={false} required value={v.endpoint} onChange={set("endpoint")} />
      <TextInput id="offsite-region" label="Region" hint="As your storage writes it. Leave auto if it has none." autoComplete="off" spellCheck={false} value={v.region} onChange={set("region")} />
      <TextInput id="offsite-bucket" label="Bucket" autoComplete="off" spellCheck={false} required value={v.bucket} onChange={set("bucket")} />
      <TextInput id="offsite-folder" label="Folder in the bucket" hint="Optional." autoComplete="off" spellCheck={false} value={v.folder} onChange={set("folder")} />
      <TextInput id="offsite-key" label={saved ? `Access key ID (saved one ends ${saved.keyEnd})` : "Access key ID"} autoComplete="off" spellCheck={false} required value={v.accessKeyId} onChange={set("accessKeyId")} />
      <TextInput id="offsite-secret" label={saved ? "Secret access key (leave blank to keep the saved one)" : "Secret access key"} type="password" autoComplete="new-password" required={!saved} value={v.secret} onChange={set("secret")} />
      <p className="hint">Use a key that may write to the bucket but not delete, so nobody who reaches this server can remove the copies.</p>
      <ActionOutcome state={state} />
      <div><Button type="submit" busy={pending} aria-disabled={pending || undefined}>{pending ? "Saving…" : saved ? "Save off-site storage" : "Turn on off-site copies"}</Button></div>
    </form>
  );
}
