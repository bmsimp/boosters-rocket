"use client";
import { useActionState } from "react";
import { saveClubAction } from "./actions";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { ClubSettings } from "@/lib/settings/club";

/** `timeZones` is the server's own list, so the browser and the server offer the same names. */
export function ClubForm({ initial, timeZones }: { initial: ClubSettings; timeZones: string[] }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) =>
    safely(() => saveClubAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Club name</span><input name="name" defaultValue={initial.name} required maxLength={60} /></label>
      <label className="field"><span>Short name (on the round badge, up to 4 letters)</span><input name="shortName" defaultValue={initial.shortName} required maxLength={4} /></label>
      <label className="field"><span>Club color</span><input name="color" type="color" defaultValue={initial.color} /></label>
      <label className="field"><span>Treasurer email (shown to parents for questions)</span><input name="treasurerEmail" type="email" defaultValue={initial.treasurerEmail ?? ""} /></label>
      <label className="field"><span>Time zone (decides which day it is for a step&apos;s dates and a due date)</span>
        <select name="timeZone" defaultValue={initial.timeZone}>{timeZones.map((z) => <option key={z} value={z}>{z.replaceAll("_", " ")}</option>)}</select></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved. Every page now uses these.</p>}
      <button className="btn" disabled={pending}>Save</button>
    </form>
  );
}
