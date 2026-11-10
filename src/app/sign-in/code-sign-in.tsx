"use client";
import { useEffect, useState } from "react";
import { CODE_SENT, CODE_REJECTED, TOO_MANY_TRIES, SIGNIN_NETWORK_FAILED } from "@/lib/parents/signin-copy";

const BASE = "/api/auth/parent";
const RESEND_SECONDS = 60;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Spec §1 The pages: email, then the 6-digit code. The page never says whether the address is on file. */
export function CodeSignIn() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "code") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      await post<{ ok: true }>("/portal-code/send", { email });
      const t = Date.now();
      setSentAt(t); setNow(t); setCode(""); setStep("code");
    } catch { setError(SIGNIN_NETWORK_FAILED); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post<{ ok: boolean; next?: string; error?: string }>("/portal-code/verify", { email, code });
      if (r.ok && r.next) { window.location.assign(r.next); return; }
      setError(r.error === "rate_limited" ? TOO_MANY_TRIES : CODE_REJECTED);
    } catch { setError(SIGNIN_NETWORK_FAILED); } finally { setBusy(false); }
  };
  const wait = Math.max(0, RESEND_SECONDS - Math.floor((now - sentAt) / 1000));

  if (step === "email") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <p className="lede">Sign in to see your students, what&apos;s owed, and this season&apos;s forms. We&apos;ll email you a 6-digit code.</p>
        <label className="field"><span>Email</span>
          <input name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <p role="alert" className="errors">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
      </form>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
      <p role="status">{CODE_SENT}</p>
      <label className="field"><span>6-digit code</span>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {error && <p role="alert" className="errors">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
      <div className="stack">
        <button type="button" className="btn btn-line" disabled={busy || wait > 0} onClick={() => void send()}>
          {wait > 0 ? `Resend code (${wait} s)` : "Resend code"}
        </button>
        <button type="button" className="btn btn-line" onClick={() => { setStep("email"); setError(null); }}>Use a different email</button>
      </div>
    </form>
  );
}
