"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { staffAuthClient } from "@/lib/auth/client";
import { Notice } from "@/app/components/notice";

const FAILED = "We couldn't start sign-in just then. Please try again in a moment.";

export function SetupStaffSignIn({ provider, label }: { provider: "microsoft" | "google"; label: string }) {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = await staffAuthClient.signIn.social({ provider, callbackURL: "/setup/finish", errorCallbackURL: "/setup?step=admin&signin=failed" });
      if (r?.error) setFailed(true);
    } catch { setFailed(true); }
  };
  return <><button type="button" className="btn" onClick={go}>{label}</button>{failed && <Notice tone="problem">{FAILED}</Notice>}</>;
}

export function SetupStaffSignOut() {
  const router = useRouter();
  return <button type="button" className="btn btn-line" onClick={async () => { await staffAuthClient.signOut(); router.push("/setup?step=admin"); router.refresh(); }}>Sign out and try again</button>;
}
