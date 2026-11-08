"use client";
import { staffAuthClient, parentAuthClient } from "@/lib/auth/client";

export function SignInButton({ door, provider, label, primary }: { door: "staff" | "parent"; provider: string; label: string; primary?: boolean }) {
  const go = () => door === "parent"
    ? parentAuthClient.signIn.social({ provider, callbackURL: "/", errorCallbackURL: "/refused" })
    : staffAuthClient.signIn.social({ provider: provider as "microsoft" | "google", callbackURL: "/staff", errorCallbackURL: "/refused" });
  return <button type="button" className={primary ? "btn" : "btn btn-line"} onClick={go}>{label}</button>;
}
