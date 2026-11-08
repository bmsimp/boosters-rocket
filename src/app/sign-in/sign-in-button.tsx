"use client";
import { useState } from "react";
import { staffAuthClient, parentAuthClient } from "@/lib/auth/client";

const FAILED = "We couldn't start sign-in just then. Please try again in a moment.";

export function SignInButton({ door, provider, label, primary }: { door: "staff" | "parent"; provider: string; label: string; primary?: boolean }) {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = door === "parent"
        ? await parentAuthClient.signIn.social({ provider, callbackURL: "/", errorCallbackURL: "/refused" })
        : await staffAuthClient.signIn.social({ provider: provider as "microsoft" | "google", callbackURL: "/staff", errorCallbackURL: "/refused" });
      if (r?.error) setFailed(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button type="button" className={primary ? "btn" : "btn btn-line"} onClick={go}>{label}</button>
      {failed && <p role="alert" className="errors inline-alert">{FAILED}</p>}
    </>
  );
}
