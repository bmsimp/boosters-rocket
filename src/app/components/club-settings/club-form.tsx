"use client";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { startTransition, useActionState, useState, type CSSProperties } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { normalizeHex } from "@/lib/theme/contrast";
import { clubCssVars, clubScheme } from "@/lib/theme/scheme";

export type ClubValues = { name: string; shortName: string; color: string; timeZone: string; treasurerEmail?: string };
type Done = { ok: true; message?: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/** The club bar as it will look in the color picked: the logo tile in the color itself, and a button and the current tab in the scheme it makes, by the same rule as the real pages. */
function Preview({ name, shortName, color }: { name: string; shortName: string; color: string }) {
  const hex = normalizeHex(color);
  if (!hex) return null;
  const style = clubCssVars(clubScheme(hex)) as CSSProperties;
  return (
    <div className="stack">
      <div className="club-preview" style={style} aria-hidden="true">
        <span className="monogram">{shortName || "?"}</span><span className="club">{name || "Your club"}</span>
        <span className="club-preview-pill">Home</span><span className="club-preview-button">Pay</span>
      </div>
      <p className="hint">Your logo tile in this color, and the buttons and tabs it gives. Whatever color you pick, the portal works out the shades so every page stays easy to read, by day and at night.</p>
    </div>
  );
}

/**
 * The club's name, short name, color and time zone (and, on the Club page, the treasurer's email): the setup's club step
 * and the Club page's change form. Values are kept in state with no form `action`, so a refusal keeps what was typed.
 * `timeZones` is the server's own list, so the browser and the server offer the same names.
 */
export function ClubForm({ initial, timeZones, save, submit, withTreasurer = false }: {
  initial: ClubValues; timeZones: string[]; save: (v: ClubValues) => Promise<Done>; submit: string; withTreasurer?: boolean;
}) {
  const [v, setV] = useState<ClubValues>(initial);
  const set = (k: keyof ClubValues) => (e: { target: { value: string } }) => setV((now) => ({ ...now, [k]: e.target.value }));
  const [state, run, pending] = useActionState(async () => safely(() => save(v), failed), null);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); startTransition(() => run()); }}>
      <label className="field"><span>Club name</span><input name="name" value={v.name} onChange={set("name")} required maxLength={60} autoComplete="organization" /></label>
      <label className="field"><span>Short name (on the round badge and the app icon, up to 4 letters)</span>
        <input name="shortName" value={v.shortName} onChange={set("shortName")} required maxLength={4} autoComplete="off" /></label>
      <label className="field"><span>Club color</span><input name="color" type="color" value={v.color} onChange={set("color")} /></label>
      <Preview name={v.name} shortName={v.shortName} color={v.color} />
      {withTreasurer && <label className="field"><span>Treasurer email (shown to parents for questions)</span>
        <input name="treasurerEmail" type="email" value={v.treasurerEmail ?? ""} onChange={set("treasurerEmail")} autoComplete="off" /></label>}
      <label className="field"><span>Time zone (decides which day it is for a step&apos;s dates and a due date)</span>
        <select name="timeZone" value={v.timeZone} onChange={set("timeZone")}>{timeZones.map((z) => <option key={z} value={z}>{z.replaceAll("_", " ")}</option>)}</select></label>
      {state && !state.ok && <ActionOutcome state={state} />}
      {state?.ok && <Notice tone="done">{state.message ?? "Saved."}</Notice>}
      <button className="btn" disabled={pending}>{pending ? "Saving…" : submit}</button>
    </form>
  );
}
