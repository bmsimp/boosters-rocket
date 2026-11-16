"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { agreeToSignAction, checkFormAction, startFormAgainAction } from "../actions";

// The parts of a form's page that act (v1 spec §9.2). Each is given only what it shows or sends: the id of the
// request, which is in the page's address already, and for the frame its address and where its messages come from.
// None of them asks for the page again: an action that worked revalidates it, and Next.js draws it again with the
// action's answer. Asking as well would draw the page twice at once.
type Result = { ok: true; message: string; settled?: boolean } | { ok: false; errors: string[] };
const failed: Result = { ok: false, errors: [ACTION_FAILED] };

function Outcome({ result }: { result: Result | null }) {
  if (!result) return null;
  return result.ok ? <p role="status">{result.message}</p> : <ul role="alert" className="errors">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** One button that runs an action for this form; the page then comes back drawn with what the server now says. */
function ActButton({ label, pendingLabel, act, primary = true }: { label: string; pendingLabel: string; act: () => Promise<Result>; primary?: boolean }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const press = async () => {
    setPending(true);
    const r = await safely(act, failed);
    setResult(r.ok ? null : r);
    setPending(false);
  };
  return (
    <div className="one-button">
      <button type="button" className={primary ? "btn" : "btn btn-line"} disabled={pending} onClick={press}>{pending ? pendingLabel : label}</button>
      <Outcome result={result} />
    </div>
  );
}

/** "I agree to sign electronically": the consent is recorded, and the page comes back with the form. */
export function AgreeButton({ requestId, label }: { requestId: string; label: string }) {
  return <ActButton label={label} pendingLabel="One moment…" act={() => agreeToSignAction(requestId)} />;
}

/** For a declined form: start it again. */
export function StartAgainButton({ requestId }: { requestId: string }) {
  return <ActButton label="Start this form again" pendingLabel="Starting…" act={() => startFormAgainAction(requestId)} />;
}

const WAITS_MS = [3_000, 6_000, 12_000, 24_000];

/**
 * Everyone has signed and Documenso is finishing the signed copy, which takes a few seconds: the page asks the server
 * a few times, further apart each time, and draws itself again as soon as the answer is that it is done.
 */
export function FinishingNote({ requestId }: { requestId: string }) {
  const [tries, setTries] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const ask = useCallback(async () => {
    const r = await safely(() => checkFormAction(requestId), failed);
    setResult(r.ok ? null : r);
    setTries((n) => n + 1);
  }, [requestId]);
  useEffect(() => {
    if (tries >= WAITS_MS.length) return;
    const timer = setTimeout(() => { void ask(); }, WAITS_MS[tries]);
    return () => clearTimeout(timer);
  }, [tries, ask]);
  return (
    <div className="one-button">
      {tries >= WAITS_MS.length && <button type="button" className="btn btn-line" onClick={() => { void ask(); }}>Check again</button>}
      <Outcome result={result} />
    </div>
  );
}

/** What Documenso's frame tells the page that holds it (verification, section 4.d). An object, or the same as JSON text. */
function actionOf(data: unknown): string | null {
  let message = data;
  if (typeof message === "string") { try { message = JSON.parse(message); } catch { return null; } }
  const action = (message as { action?: unknown } | null)?.action;
  return typeof action === "string" ? action : null;
}

/**
 * Documenso's signing frame for this guardian, embedded directly. `frameUrl` holds this guardian's own signing token
 * and nobody else's; `origin` is Documenso's address, the only place a message is believed from.
 *
 * The frame's "completed" message means only that this guardian finished. Nothing is recorded from it: the page asks
 * the server to read the document from Documenso, and shows what that says.
 */
export function SigningFrame({ requestId, frameUrl, origin, title }: { requestId: string; frameUrl: string; origin: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    const r = await safely(() => checkFormAction(requestId), failed);
    setResult(r);
    setChecking(false);
  }, [requestId]);
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      // Only Documenso's own frame, at Documenso's own address, is listened to.
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const action = actionOf(event.data);
      if (action === "document-completed" || action === "document-rejected") void check();
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [origin, check]);
  return (
    <div className="sign-frame">
      <iframe ref={frame} src={frameUrl} title={`Sign: ${title}`} />
      <p className="help">When you&apos;ve finished signing, this page says so by itself. If it doesn&apos;t, check here.</p>
      <div className="one-button">
        <button type="button" className="btn btn-line" disabled={checking} onClick={() => { void check(); }}>{checking ? "Checking…" : "Check whether it's signed"}</button>
        <Outcome result={result} />
      </div>
    </div>
  );
}
