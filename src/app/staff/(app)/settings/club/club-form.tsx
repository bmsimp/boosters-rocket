"use client";
import { useActionState } from "react";
import { saveClubAction } from "./actions";
import type { ClubSettings } from "@/lib/settings/club";

export function ClubForm({ initial }: { initial: ClubSettings }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => saveClubAction(f), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Club name</span><input name="name" defaultValue={initial.name} required maxLength={60} /></label>
      <label className="field"><span>Short name (on the round badge, up to 4 letters)</span><input name="shortName" defaultValue={initial.shortName} required maxLength={4} /></label>
      <label className="field"><span>Club colour</span><input name="colour" type="color" defaultValue={initial.colour} /></label>
      <label className="field"><span>Treasurer email (shown to parents for questions)</span><input name="treasurerEmail" type="email" defaultValue={initial.treasurerEmail ?? ""} /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved. Every page now uses these.</p>}
      <button className="btn" disabled={pending}>Save</button>
    </form>
  );
}
