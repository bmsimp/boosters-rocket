"use client";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { startTransition, useActionState, useState, type ReactNode } from "react";
import { Button, Checkbox, ChoiceGroup, KeyValue, TextInput } from "@/app/components/ui";
import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { MembershipShape, TypeRow } from "@/lib/roster/shape";
import type { ShapePreview } from "@/lib/roster/queries";
import type { QboMode } from "@/lib/db/schema";
import type { RelayCheck } from "@/lib/quickbooks/relay";
import type { RelayStage } from "@/lib/quickbooks/connection";

// These forms deliberately use no form `action`/`formAction`. React 19 calls the form's native reset() after
// such an action, and a reset puts every control back to its mount-time value while component state keeps the
// new one, so a later press would send the reverted values. Instead the state is the only source of truth: a
// `type="button"` builds the FormData from state and calls the dispatch from useActionState inside
// startTransition, which does not request a reset (only startHostTransition, used for form actions, does).

type Saved = { ok: true } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
const Errors = ({ errors }: { errors: string[] }) => <ActionOutcome state={{ ok: false, errors }} />;
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
      {state?.ok && <Notice tone="done">Saved. <a href="/staff/settings/quickbooks/setup?step=connect">Next: connect to QuickBooks</a></Notice>}
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
      {seen && !current && <Notice tone="info">The choice has changed since this preview. Select Preview again to see what it would show.</Notice>}
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
      {saved?.ok && <Notice tone="done">Saved. {saved.refreshed ? "The roster was read again with this shape." : "The roster couldn't be read again just now; it will be on the next refresh."} <a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></Notice>}
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
/** What Disconnect says about other portals that hold the same grant (spec §3 and §5, Disconnect). */
export const DISCONNECT_WORDS = {
  relayWarning: "Every portal connected to this QuickBooks company through Boosters Rocket shares one connection. Disconnecting here may disconnect the others too, such as a trial copy of this portal.",
  relayAck: "I understand that disconnecting may also disconnect any other portal connected to this company through Boosters Rocket.",
  ownApp: "If another portal uses this same Intuit app's keys for this company, it is disconnected too.",
} as const;

/**
 * On the view, tucked inside a closed section so it isn't pressed by accident. It stays mounted when the page comes
 * back disconnected, so it can say so: the page renders it whether or not QuickBooks is connected. `warning`, when
 * given, is shown above the button while connected. `through` is which app issued the tokens held: through Boosters
 * Rocket the Admin must tick the acknowledgement first (the button is aria-disabled until then, and the server refuses
 * without it, and answers a page drawn for another app than the one holding the tokens now that it is out of date);
 * with the club's own app, one line says what else it ends. Like the forms above, it sends from state with
 * a `type="button"`, so no form reset can untick the box behind React's back.
 */
export function Disconnect({ connected, disconnect, warning, through }: {
  connected: boolean; disconnect: (f: FormData) => Promise<Disconnected>; warning?: string; through: QboMode | null;
}) {
  const relay = through === "relay";
  const [ack, setAck] = useState(false);
  const [state, run, pending] = useActionState(async (_: Disconnected | null, acknowledged: boolean) => {
    // `drawnFor`: the app this page was drawn for, so the server can tell a page that showed no box from one that did.
    const f = new FormData(); f.append("drawnFor", through ?? "none"); if (relay && acknowledged) f.append("ack", "yes");
    return safely(() => disconnect(f), { ok: false as const, error: ACTION_FAILED });
  }, null);
  if (!connected) return state?.ok ? <Notice tone="done">{disconnectedNote(state.revoked)}</Notice> : null;
  const unusable = pending || (relay && !ack);
  return (
    <details className="more"><summary>Disconnect</summary>
      <p>{relay
        ? "This asks Boosters Rocket to have Intuit cancel the portal's access, and deletes the portal's copy of the connection. The portal's registration with Boosters Rocket and the last roster stay, and the roster is marked as no longer current."
        : "This asks Intuit to cancel the portal's access and deletes its copy of the connection. The Intuit app's keys and the last roster stay, and the roster is marked as no longer current."}</p>
      {relay ? <Notice tone="warning">{DISCONNECT_WORDS.relayWarning}</Notice> : <p>{DISCONNECT_WORDS.ownApp}</p>}
      {warning && <Notice tone="warning">{warning}</Notice>}
      <form onSubmit={noSubmit} className="stack">
        {relay && <Checkbox id="qbo-disconnect-ack" name="ack" value="yes" label={DISCONNECT_WORDS.relayAck} checked={ack} onChange={(e) => setAck(e.target.checked)} />}
        {state && !state.ok && <Notice tone="problem">{state.error}</Notice>}
        <p><Button variant="secondary" busy={pending} aria-disabled={unusable || undefined}
          onClick={() => { if (!unusable) startTransition(() => run(ack)); }}>{pending ? "Disconnecting…" : "Disconnect QuickBooks"}</Button></p>
      </form>
    </details>
  );
}

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failedDone: Done = { ok: false, errors: [ACTION_FAILED] };
const MODES: { value: QboMode; label: string; hint: string }[] = [
  { value: "relay", label: "Connect through Boosters Rocket", hint: "The usual way: register this portal once by email, then sign in to Intuit. The club needs no Intuit app of its own." },
  { value: "own_app", label: "Use our own Intuit app", hint: "For a club that has registered an app with Intuit itself: its Client ID and secret go here." },
];

/**
 * Step 1, "How to connect". The choice shows its own part of the step underneath (`relay` or `ownApp`) as soon as it is
 * picked; saving it is one press. The club's own app is saved with its keys (saving them is the choice), so with none
 * saved yet that choice has no press of its own. Leaving the relay while connected through it is refused here and on
 * the server.
 */
export function ConnectModeForm({ saved, keysSaved, relayConnected, save, relay, ownApp }: {
  saved: QboMode; keysSaved: boolean; relayConnected: boolean; save: (f: FormData) => Promise<Done>; relay: ReactNode; ownApp: ReactNode;
}) {
  const [mode, setMode] = useState<QboMode>(saved);
  const [state, run, pending] = useActionState(async (_: Done | null, m: QboMode) => {
    const f = new FormData(); f.append("mode", m);
    return safely(() => save(f), failedDone);
  }, null);
  const blocked = mode === "own_app" && relayConnected;
  const pressable = mode !== saved && !blocked && (mode === "relay" || keysSaved);
  return (
    <div className="stack">
      <ChoiceGroup name="mode" legend="How the portal connects to QuickBooks" options={MODES} value={mode} onChange={(v) => setMode(v === "own_app" ? "own_app" : "relay")} cols={1} />
      {mode !== saved && !blocked && !pressable && <Notice tone="info">Save the Intuit app&apos;s keys below to use the club&apos;s own app. Saving them saves this choice too.</Notice>}
      {pressable && <p><Button busy={pending} onClick={() => { if (!pending) startTransition(() => run(mode)); }}>{pending ? "Saving…" : "Save this choice"}</Button></p>}
      <ActionOutcome state={state} />
      {blocked
        ? <Notice tone="warning">QuickBooks is connected through Boosters Rocket. Disconnect first, from QuickBooks settings, then choose the club&apos;s own Intuit app. <a href="/staff/settings/quickbooks">QuickBooks settings</a></Notice>
        : mode === "relay" ? relay : ownApp}
    </div>
  );
}

type PortalIdSaved = { ok: true; message: string; check: RelayCheck | null } | { ok: false; errors: string[] };
type Checked = { ok: true; check: RelayCheck | null };
const ENVIRONMENT_WORDS = { production: "to the club's real books", sandbox: "to Intuit sandbox (test) companies" } as const;

/** Why the waiting stage offers no form: the registration can't change while a connect through the relay holds it. */
export const REGISTRATION_HELD = "The portal id can't be saved while QuickBooks is connected, or being connected, through Boosters Rocket. Finish or end that first, then come back to this step.";

/** The relay's answer to the check, in words. The registered name is the relay's text: a text child, never markup. */
export function CheckAnswer({ check, again, checking }: { check: RelayCheck; again: () => void; checking: boolean }) {
  if (check.answer === "registered") {
    const may = check.environments.map((e) => ENVIRONMENT_WORDS[e]);
    return <Notice tone="done">{`Registered as ${check.name}.`} {may.length ? `It may connect ${may.join(" and ")}.` : "Boosters Rocket hasn't allowed it to connect to any QuickBooks yet. Email support@boostersrocket.com."}</Notice>;
  }
  if (check.answer === "not_matching") {
    return <Notice tone="problem">That portal id and this portal&apos;s key don&apos;t match what Boosters Rocket registered, or this server&apos;s clock is more than 5 minutes off. Check the id against Boosters Rocket&apos;s email, and if it is right, email support@boostersrocket.com. The id is saved as typed.</Notice>;
  }
  return (
    <Notice tone="warning">Boosters Rocket couldn&apos;t be reached just now, so the registration wasn&apos;t checked. The portal id is saved.{" "}
      <Button variant="secondary" size="sm" busy={checking} onClick={again}>{checking ? "Checking…" : "Check again"}</Button></Notice>
  );
}

/**
 * Registration with Boosters Rocket, the relay part of step 1, through its three stages: not registered yet, waiting
 * for the id, ready to connect. One component across them, so the check's answer stays on the page when saving the id
 * moves it on a stage. It is given only what it shows, all of it public: the portal's address, its public key and id.
 * `mayChange` is false while connected, or being connected, through the relay: then neither the id nor the key may
 * change (Disconnect first, or let the connect finish), and no stage offers a form to change them.
 */
export function RelayRegistration({ stage, address, addressFits, publicKey, portalId, mailto, mayChange, makeKey, saveId, check }: {
  stage: RelayStage; address: string; addressFits: boolean; publicKey: string | null; portalId: string | null; mailto: string | null; mayChange: boolean;
  makeKey: (f: FormData) => Promise<Done>; saveId: (f: FormData) => Promise<PortalIdSaved>; check: () => Promise<Checked>;
}) {
  const [typed, setTyped] = useState("");
  const [answer, setAnswer] = useState<RelayCheck | null>(null);
  const [made, runMake, making] = useActionState(async (_: Done | null, replace: boolean) => {
    const f = new FormData(); if (replace) f.append("replace", "yes");
    const r = await safely(() => makeKey(f), failedDone);
    if (r.ok) setAnswer(null); // a new key: the last check was of the old one
    return r;
  }, null);
  const [saved, runSave, saving] = useActionState(async (_: PortalIdSaved | null, id: string): Promise<PortalIdSaved> => {
    const f = new FormData(); f.append("portalId", id);
    const r = await safely<PortalIdSaved>(() => saveId(f), { ok: false, errors: [ACTION_FAILED] });
    if (r.ok) { setTyped(""); setAnswer(r.check); }
    return r;
  }, null);
  const [, runCheck, checking] = useActionState(async () => {
    const r = await safely(check, { ok: true as const, check: { answer: "unreachable" as const } });
    setAnswer(r.check);
    return null;
  }, null);
  const again = () => { if (!checking) startTransition(() => runCheck()); };
  const idForm = (label: string) => (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!saving) startTransition(() => runSave(typed)); }}>
      <TextInput id="relay-portal-id" name="portalId" label={label} hint="From Boosters Rocket's email: brp_ and 16 letters or digits." autoComplete="off" spellCheck={false}
        value={typed} onChange={(e) => setTyped(e.target.value)} />
      {saved && !saved.ok && <ActionOutcome state={saved} />}
      <p><Button type="submit" busy={saving}>{saving ? "Saving…" : "Save the portal id"}</Button></p>
    </form>
  );
  const copies = publicKey && (
    <>
      <CopyField label="This portal's address" value={address} />
      <CopyField label="This portal's public key" value={publicKey} />
    </>
  );
  const https = addressFits ? null
    : <Notice tone="problem">Boosters Rocket can register only a portal with an https address, and this one is {address}. Whoever installed the portal sets its address (APP_URL). Once it starts with https, come back to this step.</Notice>;
  return (
    <section className="box-section stack" aria-labelledby="relay-stage-h">
      <h3 id="relay-stage-h">{stage === "not_registered" ? "Not registered yet" : stage === "waiting" ? "Waiting for the id" : "Ready to connect"}</h3>
      {stage === "not_registered" && (
        <>
          <p>Boosters Rocket connects the portal to QuickBooks once it knows this portal. First the portal makes its own key: a public half to send to Boosters Rocket, and a private half that never leaves this server.</p>
          <ActionOutcome state={made} />
          <p><Button busy={making} onClick={() => { if (!making) startTransition(() => runMake(false)); }}>{making ? "Making the key…" : "Make this portal's key"}</Button></p>
        </>
      )}
      {stage === "waiting" && (
        <>
          {made?.ok && <ActionOutcome state={made} />}
          <p>Email these to support@boostersrocket.com. Boosters Rocket registers the portal and emails you back its id.</p>
          {copies}
          {mailto && <p><a className="link-line" href={mailto}>Write the email</a></p>}
          {https ?? (mayChange ? idForm("Portal id") : <Notice tone="info" live="none">{REGISTRATION_HELD}</Notice>)}
        </>
      )}
      {stage === "ready" && (
        <>
          <p>The portal is registered with Boosters Rocket. Next, connect to QuickBooks in step 2.</p>
          <KeyValue items={[{ key: "id", label: "Portal id", value: <code>{portalId}</code> }]} />
          {copies}
          {https}
          {answer ? <CheckAnswer check={answer} again={again} checking={checking} />
            : <p><Button variant="secondary" busy={checking} onClick={again}>{checking ? "Checking…" : "Check the registration"}</Button></p>}
          {answer && answer.answer !== "unreachable" && <p><Button variant="quiet" busy={checking} onClick={again}>{checking ? "Checking…" : "Check again"}</Button></p>}
          {!https && mayChange && <details className="more"><summary>Change the portal id</summary>{idForm("New portal id")}</details>}
          {mayChange && (
            <details className="more"><summary>Make a new key</summary>
              <p>A new key replaces this one and clears the saved portal id. Boosters Rocket then registers the new public key and sends a new id before the portal can connect.</p>
              {made && !made.ok && <ActionOutcome state={made} />}
              <p><Button variant="secondary" busy={making} onClick={() => { if (!making) startTransition(() => runMake(true)); }}>{making ? "Making the key…" : "Make a new key"}</Button></p>
            </details>
          )}
        </>
      )}
      {stage !== "ready" && answer && <CheckAnswer check={answer} again={again} checking={checking} />}
    </section>
  );
}

const ENVIRONMENTS: { value: "production" | "sandbox"; label: string; hint: string }[] = [
  { value: "production", label: "The club's real books", hint: "The club's own QuickBooks Online company." },
  { value: "sandbox", label: "An Intuit sandbox (test) company", hint: "One of the test companies Intuit gives a developer account, for trying the portal out." },
];

/**
 * Step 2 through Boosters Rocket: which QuickBooks, then "Connect to QuickBooks", a plain form post that ends in a
 * redirect to the relay. While connected, the other QuickBooks can't be chosen (the server refuses it too): connecting
 * again renews the one connected. It is given only what it shows.
 */
export function RelayConnectForm({ environment, locked, begin }: { environment: "production" | "sandbox" | null; locked: boolean; begin: (f: FormData) => Promise<void> }) {
  const [chosen, setChosen] = useState<"production" | "sandbox">(environment ?? "production");
  const options = ENVIRONMENTS.map((o) => ({ ...o, disabled: locked && o.value !== environment }));
  return (
    <form action={begin} className="stack">
      <ChoiceGroup name="environment" legend="Which QuickBooks" hint={locked ? "To connect the other, disconnect first, from QuickBooks settings." : undefined}
        options={options} value={chosen} onChange={(v) => setChosen(v === "sandbox" ? "sandbox" : "production")} cols={1} />
      <p><Button type="submit">Connect to QuickBooks</Button></p>
    </form>
  );
}
