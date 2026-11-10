"use client";
import { useState } from "react";
import { staffAuthClient } from "@/lib/auth/client";

const FAILED = "We couldn't start sign-in just then. Please try again in a moment.";

export function SignInButton({ provider, label, primary }: { provider: "microsoft" | "google"; label: string; primary?: boolean }) {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = await staffAuthClient.signIn.social({ provider, callbackURL: "/staff", errorCallbackURL: "/refused" });
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
