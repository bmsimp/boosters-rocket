"use client";
import { useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { QboConnectionView } from "@/lib/quickbooks/connection";
import type { MembershipShape, TypeRow } from "@/lib/roster/shape";
import type { ShapePreview } from "@/lib/roster/queries";

type Saved = { ok: true } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;

/** Step 1: the Intuit app's keys. A saved secret is never sent here; a blank field keeps it. */
export function AppKeysForm({ view, save }: { view: QboConnectionView; save: (f: FormData) => Promise<Saved> }) {
  const [state, run, pending] = useActionState(async (_: Saved | null, f: FormData) => safely(() => save(f), failed), null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Client ID</span>
        <input name="clientId" required autoComplete="off" spellCheck={false} defaultValue={view.clientId ?? ""} /></label>
      <label className="field"><span>Client secret{view.configured ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="clientSecret" type="password" autoComplete="new-password" required={!view.configured} /></label>
      <fieldset className="field"><legend>Which QuickBooks</legend>
        <label><input type="radio" name="environment" value="sandbox" defaultChecked={view.environment !== "production"} /> Sandbox (Intuit&apos;s test companies, with the app&apos;s Development keys)</label>
        <label><input type="radio" name="environment" value="production" defaultChecked={view.environment === "production"} /> Production (the club&apos;s real books, with the app&apos;s Production keys)</label>
      </fieldset>
      {state && !state.ok && <Errors errors={state.errors} />}
      {state?.ok && <p role="status">Saved. <a href="/staff/settings/quickbooks/setup?step=connect">Next: sign in to Intuit</a></p>}
      <button className="btn" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}

type PreviewResult = { ok: true; preview: ShapePreview } | { ok: false; errors: string[] };
type ShapeSaved = { ok: true; refreshed: boolean } | { ok: false; errors: string[] };
const names = (list: string[], total: number) => (list.length ? ` (${list.join(", ")}${total > list.length ? ", and more" : ""})` : "");

/** Step 3: flat or layered, chosen from the customer types found, with a preview before saving. */
export function ShapeForm({ types, shape, preview, save }: {
  types: TypeRow[]; shape: MembershipShape | null; preview: (f: FormData) => Promise<PreviewResult>; save: (f: FormData) => Promise<ShapeSaved>;
}) {
  const [kind, setKind] = useState<"flat" | "layered">(shape?.kind ?? "layered");
  const [seen, runPreview, previewing] = useActionState(async (_: PreviewResult | null, f: FormData) => safely(() => preview(f), failed), null);
  const [saved, runSave, saving] = useActionState(async (_: ShapeSaved | null, f: FormData) => safely(() => save(f), failed), null);
  const layered = shape?.kind === "layered" ? shape : null, flat = shape?.kind === "flat" ? shape : null;
  // Controlled, like `kind`: React 19 resets a form after a function action runs, so uncontrolled inputs would
  // fall back to their defaults on Preview and Save would then send those defaults instead of what was previewed.
  const [family, setFamily] = useState(layered?.familyTypeId ?? "");
  const [student, setStudent] = useState(layered?.studentTypeId ?? "");
  const [parent, setParent] = useState(layered?.parentTypeId ?? "");
  const [members, setMembers] = useState<string[]>(flat?.memberTypeIds ?? []);
  const pick = (name: string, label: string, value: string, set: (v: string) => void, optional: boolean) => (
    <label className="field"><span>{label}</span>
      <select name={name} value={value} onChange={(e) => set(e.target.value)} required={!optional}>
        <option value="">{optional ? "Not identified in QuickBooks" : "Choose a type"}</option>
        {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
      </select></label>
  );
  const p = seen?.ok ? seen.preview : null;
  return (
    <form className="stack">
      <fieldset className="field"><legend>How is the club&apos;s membership laid out in QuickBooks?</legend>
        <label><input type="radio" name="kind" value="layered" checked={kind === "layered"} onChange={() => setKind("layered")} /> Layered: a family customer, with its students and parents as sub-customers under it</label>
        <label><input type="radio" name="kind" value="flat" checked={kind === "flat"} onChange={() => setKind("flat")} /> Flat: each member is a customer of their own</label>
      </fieldset>
      {kind === "layered" ? (
        <>
          {pick("family", "A family is a customer of this type", family, setFamily, false)}
          {pick("student", "A student is a sub-customer of this type", student, setStudent, true)}
          {pick("parent", "A parent is a sub-customer of this type", parent, setParent, true)}
        </>
      ) : (
        <fieldset className="field"><legend>A member is a customer of any of these types</legend>
          {types.map((t) => <label key={t.qboId}><input type="checkbox" name="members" value={t.qboId} checked={members.includes(t.qboId)} onChange={(e) => setMembers((m) => (e.target.checked ? [...m, t.qboId] : m.filter((x) => x !== t.qboId)))} /> {t.name}</label>)}
        </fieldset>
      )}
      {seen && !seen.ok && <Errors errors={seen.errors} />}
      {p && (
        <div role="status" className="stack">
          <p><b>With this choice the portal would show:</b></p>
          {kind === "layered" ? (
            <ul>
              <li>{p.families} families{names(p.samples.families, p.families)}</li>
              <li>{p.students} students{names(p.samples.students, p.students)}</li>
              <li>{p.parents} parents{names(p.samples.parents, p.parents)}</li>
              <li>{p.outside} customers outside the portal</li>
            </ul>
          ) : (
            <ul><li>{p.members} members{names(p.samples.members, p.members)}</li><li>{p.outside} customers outside the portal</li></ul>
          )}
          <p className="hint">If that isn&apos;t what you expect, change the choice and preview again before saving.</p>
        </div>
      )}
      {saved && !saved.ok && <Errors errors={saved.errors} />}
      {saved?.ok && <p role="status">Saved. {saved.refreshed ? "The roster was read again with this shape." : "The roster couldn't be read again just now; it will be on the next refresh."} <a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>}
      <div className="row-actions">
        <button className="btn btn-line" formAction={runPreview} disabled={previewing || saving}>{previewing ? "Counting…" : "Preview"}</button>
        <button className="btn" formAction={runSave} disabled={previewing || saving}>{saving ? "Saving…" : "Save this shape"}</button>
      </div>
    </form>
  );
}

type Disconnected = { ok: true } | { ok: false; error: string };
/** On the view, tucked inside a closed section so it isn't pressed by accident. */
export function DisconnectButton({ disconnect }: { disconnect: () => Promise<Disconnected> }) {
  const [state, run, pending] = useActionState(async () => safely(() => disconnect(), { ok: false as const, error: ACTION_FAILED }), null);
  return (
    <form action={run} className="stack">
      {state && !state.ok && <p role="alert" className="errors">{state.error}</p>}
      {state?.ok && <p role="status">Disconnected.</p>}
      <button className="btn btn-line" disabled={pending}>{pending ? "Disconnecting…" : "Disconnect QuickBooks"}</button>
    </form>
  );
}
