"use client";
import { useEffect, useState } from "react";
import { CODE_SENT, CODE_REJECTED, TOO_MANY_TRIES, signinFailure } from "@/lib/parents/signin-copy";
import { clearCodeStep, deviceStore, loadCodeStep, saveCodeStep } from "./code-step";

const BASE = "/api/auth/parent";
const RESEND_SECONDS = 60;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!r.ok) throw new HttpStatus(r.status);
  return (await r.json()) as T;
}
class HttpStatus extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
const failure = (e: unknown) => signinFailure(e instanceof HttpStatus ? e.status : null);

/**
 * Spec §1 The pages: email, then the 6-digit code. The page never says whether the address is on file. `next` is the
 * page the parent asked for, already checked by the sign-in page; the portal checks it again when the code is right.
 */
export function CodeSignIn({ next }: { next: string | null }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(0);
  const [back, setBack] = useState(next);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reload in the middle (a phone reloads an installed app when the parent comes back from their mail) picks the
  // code step up where it was. What the device kept is unknowable on the server, so it is read after mount.
  useEffect(() => {
    const saved = loadCodeStep(deviceStore(), Date.now());
    if (!saved) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setEmail(saved.email); setSentAt(saved.sentAt); setNow(Date.now()); setStep("code");
    if (!next) setBack(saved.next);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [next]);

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
      saveCodeStep(deviceStore(), { email, sentAt: t, next: back });
      setSentAt(t); setNow(t); setCode(""); setStep("code");
    } catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post<{ ok: boolean; next?: string; error?: string }>("/portal-code/verify", { email, code, ...(back ? { next: back } : {}) });
      if (r.ok && r.next) { clearCodeStep(deviceStore()); window.location.assign(r.next); return; }
      setError(r.error === "rate_limited" ? TOO_MANY_TRIES : CODE_REJECTED);
    } catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  // Starting over keeps nothing of the step it leaves, which on a shared device may have been somebody else's: not the
  // address in the field, and not the page they were heading to. Only what this page load itself was asked for stays.
  const startOver = () => { clearCodeStep(deviceStore()); setStep("email"); setEmail(""); setBack(next); setCode(""); setError(null); };
  const wait = Math.max(0, RESEND_SECONDS - Math.floor((now - sentAt) / 1000));

  if (step === "email") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <p className="lede">Sign in to see your students and what&apos;s owed. We&apos;ll email you a 6-digit code.</p>
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
        <button type="button" className="btn btn-line" onClick={startOver}>Use a different email</button>
      </div>
    </form>
  );
}
