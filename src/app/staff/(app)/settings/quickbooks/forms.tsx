"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { MembershipShape, TypeRow } from "@/lib/roster/shape";
import type { ShapePreview } from "@/lib/roster/queries";

// These forms deliberately use no form `action`/`formAction`. React 19 calls the form's native reset() after
// such an action, and a reset puts every control back to its mount-time value while component state keeps the
// new one, so a later press would send the reverted values. Instead the state is the only source of truth: a
// `type="button"` builds the FormData from state and calls the dispatch from useActionState inside
// startTransition, which does not request a reset (only startHostTransition, used for form actions, does).

type Saved = { ok: true } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

export type AppKeys = { clientId: string; clientSecret: string; environment: "sandbox" | "production" };
/** The fields saveQboAppAction reads. A blank secret is sent blank, which keeps the saved one. */
export function appKeysFormData(k: AppKeys): FormData {
  const f = new FormData();
  f.append("clientId", k.clientId); f.append("clientSecret", k.clientSecret); f.append("environment", k.environment);
  return f;
}

/** Step 1: the Intuit app's keys. A saved secret is never sent here; a blank field keeps it. */
export function AppKeysForm({ configured, clientId: savedId, environment: savedEnvironment, save }: {
  configured: boolean; clientId: string | null; environment: "sandbox" | "production" | null; save: (f: FormData) => Promise<Saved>;
}) {
  const [clientId, setClientId] = useState(savedId ?? "");
  const [clientSecret, setClientSecret] = useState(""); // never initialized from props: there is no secret to give it
  const [environment, setEnvironment] = useState<"sandbox" | "production">(savedEnvironment ?? "sandbox");
  const [state, run, pending] = useActionState(async (_: Saved | null, keys: AppKeys) => {
    const r = await safely(() => save(appKeysFormData(keys)), failed);
    if (r.ok) setClientSecret("");
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Client ID</span>
        <input name="clientId" required autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
      <label className="field"><span>Client secret{configured ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="clientSecret" type="password" autoComplete="new-password" required={!configured} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
      <fieldset className="field"><legend>Which QuickBooks</legend>
        <label><input type="radio" name="environment" value="sandbox" checked={environment === "sandbox"} onChange={() => setEnvironment("sandbox")} /> Sandbox (Intuit&apos;s test companies, with the app&apos;s Development keys)</label>
        <label><input type="radio" name="environment" value="production" checked={environment === "production"} onChange={() => setEnvironment("production")} /> Production (the club&apos;s real books, with the app&apos;s Production keys)</label>
      </fieldset>
      {state && !state.ok && <Errors errors={state.errors} />}
      {state?.ok && <p role="status">Saved. <a href="/staff/settings/quickbooks/setup?step=connect">Next: sign in to Intuit</a></p>}
      <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run({ clientId, clientSecret, environment }))}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}

type PreviewResult = { ok: true; preview: ShapePreview } | { ok: false; errors: string[] };
type ShapeSaved = { ok: true; refreshed: boolean } | { ok: false; errors: string[] };
const names = (list: string[], total: number) => (list.length ? ` (${list.join(", ")}${total > list.length ? ", and more" : ""})` : "");

export type ShapeChoice = { kind: "flat" | "layered"; family: string; student: string; parent: string; members: string[] };
/** The fields previewShapeAction and saveShapeAction read; nothing for the kind that isn't chosen. Preview and Save both use it. */
export function shapeFormData(c: ShapeChoice): FormData {
  const f = new FormData();
  f.append("kind", c.kind);
  if (c.kind === "layered") { f.append("family", c.family); f.append("student", c.student); f.append("parent", c.parent); }
  else for (const m of c.members) f.append("members", m);
  return f;
}
/** Whether two choices would send the same thing: only the fields of the chosen kind count, and member order doesn't. */
export function sameChoice(a: ShapeChoice, b: ShapeChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "layered") return a.family === b.family && a.student === b.student && a.parent === b.parent;
  const x = [...a.members].sort(), y = [...b.members].sort();
  return x.length === y.length && x.every((m, i) => m === y[i]);
}

type Previewed = { choice: ShapeChoice; result: PreviewResult };

/** Step 3: flat or layered, chosen from the customer types found, with a preview before saving. */
export function ShapeForm({ types, shape, preview, save }: {
  types: TypeRow[]; shape: MembershipShape | null; preview: (f: FormData) => Promise<PreviewResult>; save: (f: FormData) => Promise<ShapeSaved>;
}) {
  const layered = shape?.kind === "layered" ? shape : null, flat = shape?.kind === "flat" ? shape : null;
  const [kind, setKind] = useState<"flat" | "layered">(shape?.kind ?? "layered");
  const [family, setFamily] = useState(layered?.familyTypeId ?? "");
  const [student, setStudent] = useState(layered?.studentTypeId ?? "");
  const [parent, setParent] = useState(layered?.parentTypeId ?? "");
  const [members, setMembers] = useState<string[]>(flat?.memberTypeIds ?? []);
  const choice: ShapeChoice = { kind, family, student, parent, members };
  const [seen, runPreview, previewing] = useActionState(async (_: Previewed | null, c: ShapeChoice): Promise<Previewed> => ({ choice: c, result: await safely(() => preview(shapeFormData(c)), failed) }), null);
  const [saved, runSave, saving] = useActionState(async (_: ShapeSaved | null, c: ShapeChoice) => safely(() => save(shapeFormData(c)), failed), null);
  const pick = (name: string, label: string, value: string, set: (v: string) => void, optional: boolean) => (
    <label className="field"><span>{label}</span>
      <select name={name} value={value} onChange={(e) => set(e.target.value)} required={!optional}>
        <option value="">{optional ? "Not identified in QuickBooks" : "Choose a type"}</option>
        {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
      </select></label>
  );
  const current = seen && sameChoice(seen.choice, choice);
  const p = seen && current && seen.result.ok ? seen.result.preview : null;
  return (
    <form className="stack" onSubmit={noSubmit}>
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
      {seen && current && !seen.result.ok && <Errors errors={seen.result.errors} />}
      {seen && !current && <p role="status" className="hint">The choice has changed since this preview. Select Preview again to see what it would show.</p>}
      {p && (
        <div role="status" className="stack">
          <p><b>With this choice the portal would show:</b></p>
          {seen?.choice.kind === "layered" ? (
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
        <button type="button" className="btn btn-line" disabled={previewing || saving} onClick={() => startTransition(() => runPreview(choice))}>{previewing ? "Counting…" : "Preview"}</button>
        <button type="button" className="btn" disabled={previewing || saving} onClick={() => startTransition(() => runSave(choice))}>{saving ? "Saving…" : "Save this shape"}</button>
      </div>
    </form>
  );
}

type Disconnected = { ok: true; revoked: boolean } | { ok: false; error: string };
/** What the view says after a disconnect. When Intuit didn't confirm, the portal's access may still stand there. */
export function disconnectedNote(revoked: boolean): string {
  const kept = "The roster stays as it was last read, and is marked as no longer current.";
  return revoked ? `Disconnected. ${kept}` : `Disconnected here, but Intuit didn't confirm that it canceled the portal's access. ${kept}`;
}
/**
 * On the view, tucked inside a closed section so it isn't pressed by accident. It stays mounted when the page comes
 * back disconnected, so it can say so: the page renders it whether or not QuickBooks is connected.
 */
export function Disconnect({ connected, disconnect }: { connected: boolean; disconnect: () => Promise<Disconnected> }) {
  const [state, run, pending] = useActionState(async () => safely(() => disconnect(), { ok: false as const, error: ACTION_FAILED }), null);
  if (!connected) return state?.ok ? <p role="status">{disconnectedNote(state.revoked)}</p> : null;
  return (
    <details><summary>Disconnect</summary>
      <p>This asks Intuit to cancel the portal&apos;s access and deletes its copy of the connection. The Intuit app&apos;s keys and the last roster stay, and the roster is marked as no longer current.</p>
      <form action={run} className="stack">
        {state && !state.ok && <p role="alert" className="errors">{state.error}</p>}
        <button className="btn btn-line" disabled={pending}>{pending ? "Disconnecting…" : "Disconnect QuickBooks"}</button>
      </form>
    </details>
  );
}
