"use client";
import { startTransition, useActionState, useState } from "react";
import { ActionOutcome } from "@/app/components/notice";
import { Button, TextInput } from "@/app/components/ui";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { setMyContactEmailAction } from "./actions";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/**
 * The contact email families see on the staff member's profile: a field with Save, and, while they have set one of their
 * own, "Use my sign-in address". Given only their own addresses: the one shown, and their sign-in address.
 */
export function ContactEmailForm({ shown, own, signIn }: { shown: string; own: boolean; signIn: string }) {
  const [value, setValue] = useState(shown);
  const [state, run, pending] = useActionState(async (_: Done | null, email: string | null) => safely(() => setMyContactEmailAction(email), failed), null);
  const press = (email: string | null) => { if (!pending) startTransition(() => run(email)); };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); press(value); }}>
      <TextInput id="contact-email" label="Contact email" type="email" autoComplete="email" maxLength={254} required
        value={value} onChange={(e) => setValue(e.target.value)}
        hint="Your sign-in address, or another you'd rather families write to, such as a club mailbox." />
      {state && <ActionOutcome state={state} />}
      <div className="row-actions">
        <Button type="submit" variant="outlined" busy={pending}>Save contact email</Button>
        {own && <Button variant="text" busy={pending} onClick={() => { if (pending) return; setValue(signIn); press(null); }}>Use my sign-in address</Button>}
      </div>
    </form>
  );
}
