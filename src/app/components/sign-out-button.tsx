"use client";
import { useState } from "react";
import { staffAuthClient, parentAuthClient } from "@/lib/auth/client";
import { Notice } from "./notice";

/** Ends this door's session, then goes to that door's sign-in page. */
export function SignOutButton({ door }: { door: "staff" | "parent" }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setBusy(true); setFailed(false);
    try {
      const r = await (door === "parent" ? parentAuthClient : staffAuthClient).signOut();
      if (r.error) throw new Error("sign-out failed");
      // A full page load, so nothing from the signed-in pages stays on screen.
      window.location.assign(door === "parent" ? "/sign-in" : "/staff/sign-in");
    } catch {
      setBusy(false); setFailed(true);
    }
  };
  return (
    <div className="sign-out">
      <button type="button" className="btn btn-outlined" onClick={go} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>
      {/* Staff pages answer in notices (docs/agents/ui.md); the parent pages keep their own error line. */}
      {failed && (door === "staff" ? <Notice tone="problem">We couldn&apos;t sign you out just then. Please try again.</Notice>
        : <p role="alert" className="errors">We couldn&apos;t sign you out just then. Please try again.</p>)}
    </div>
  );
}
