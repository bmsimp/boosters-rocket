"use client";
import { useState } from "react";
import { Button, BulkSelect, ConfirmDialog, DataTable, Drawer, Notice, Sheet, StepsChoice, TextInput, selectionPayload, useBulkSelection, type Confirmed } from "@/app/components/ui";

/** The gallery's samples of the dialogs, bulk select and StepsChoice: sample words only, and no press changes anything. */

export function DrawerSample() {
  return (
    <Drawer param="ds-drawer" label="Change the event" description="Families see the new name and date at once.">
      <form className="stack" onSubmit={(e) => e.preventDefault()}>
        <TextInput id="ds-drawer-name" label="Event name" defaultValue="Sample car wash" autoComplete="off" />
        <TextInput id="ds-drawer-date" label="Date" type="date" defaultValue="2027-04-10" />
        <p><Button type="submit">Save the event</Button></p>
      </form>
    </Drawer>
  );
}

export function ConfirmSample() {
  return (
    <div className="ds-samples">
      <ConfirmDialog label="Disconnect QuickBooks" busyLabel="Disconnecting…" consequence="The portal stops reading QuickBooks. The last roster stays, marked as no longer current."
        check="I understand other portals on this company through Boosters Rocket may be disconnected too."
        act={async (): Promise<Confirmed> => ({ ok: true, message: "A sample: nothing was disconnected." })} />
      <ConfirmDialog label="Remove this credit" consequence="It stops counting toward what the club asks. Only staff see your reason."
        reason={{ label: "Why it's being removed (only staff see this)", maxLength: 500 }}
        act={async (text: string): Promise<Confirmed> => (text ? { ok: true, message: "A sample: nothing was removed." } : { ok: false, errors: ["Say why it's being removed."] })} />
    </div>
  );
}

export function StepsChoiceSample() {
  return (
    <StepsChoice name="ds-way" legend="How to make the app" options={[
      { value: "hand", label: "By hand", hint: "In the admin center.", steps: <ol className="steps-list"><li>Open the admin center.</li><li>Make the app.</li></ol> },
      { value: "script", label: "With the PowerShell script", hint: "It does the steps for you.", steps: <p>Download the script and run it.</p> },
    ]} />
  );
}

type Fam = { id: string; name: string; email: string | null };
const FAMILIES: Fam[] = [
  { id: "f1", name: "Sample Family", email: "sample@example.org" },
  { id: "f2", name: "Rivera Sample Family", email: "rivera@example.org" },
  { id: "f3", name: "Chen Sample Family", email: null },
  { id: "f4", name: "Okafor Sample Family", email: "okafor@example.org" },
  { id: "f5", name: "Patel Sample Family", email: "patel@example.org" },
];
const MATCHING = 12;

/**
 * The bulk pattern, ready for a real action: the selection goes to the server as selectionPayload(), which checks
 * every id again; the Drawer first says what would happen to each, then, once pressed, what did, row by row.
 */
function SampleReminder() {
  const b = useBulkSelection();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; why?: string }[] | null>(null);
  const chosen = b.selection.allMatching ? FAMILIES.filter((f) => !b.selection.except.has(f.id)) : FAMILIES.filter((f) => b.selection.ids.has(f.id));
  const more = b.selection.allMatching ? MATCHING - FAMILIES.length : 0;
  const send = () => {
    void selectionPayload(b.selection); // what a real action would send, for the server to check again
    setResults(chosen.map((f) => (f.email ? { name: f.name, ok: true } : { name: f.name, ok: false, why: "No email address on file" })));
  };
  return (
    <>
      <Button variant="tonal" size="sm" onClick={() => { setResults(null); setOpen(true); }}>Send a reminder</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Send a reminder to ${b.count} ${b.count === 1 ? "family" : "families"}`}
        description="A sample: nothing is sent.">
        {results === null ? (
          <>
            <p>Each family is checked again before anything is sent.</p>
            <ul>{chosen.map((f) => <li key={f.id}>{f.name}{f.email ? "" : ": no email address, so it will be skipped"}</li>)}{more > 0 && <li>and {more} more that match</li>}</ul>
            <p><Button onClick={send}>Send {b.count} {b.count === 1 ? "reminder" : "reminders"}</Button></p>
          </>
        ) : (
          <>
            <Notice tone={results.every((r) => r.ok) ? "done" : "warning"}>{results.filter((r) => r.ok).length} sent, {results.filter((r) => !r.ok).length} not sent.</Notice>
            <ul>{results.map((r) => <li key={r.name}>{r.name}: {r.ok ? "Sent" : `Not sent. ${r.why}.`}</li>)}</ul>
            <p><Button variant="outlined" onClick={() => { setOpen(false); b.clear(); }}>Done</Button></p>
          </>
        )}
      </Sheet>
    </>
  );
}

export function BulkSample() {
  return (
    <BulkSelect pageIds={FAMILIES.map((f) => f.id)} total={MATCHING} noun={{ one: "family", many: "families" }} actions={<SampleReminder />}>
      <DataTable caption="Sample families (5 of 12 shown)" rows={FAMILIES} rowKey={(f) => f.id} select={{ label: (f) => f.name }} columns={[
        { key: "name", header: "Family", rowHeader: true, cell: (f) => f.name },
        { key: "email", header: "Email", cell: (f) => f.email ?? "None on file" },
      ]} />
    </BulkSelect>
  );
}
