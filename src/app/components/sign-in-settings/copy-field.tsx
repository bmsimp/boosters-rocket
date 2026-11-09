"use client";
import { useState } from "react";

/** A value the admin copies into Microsoft or Google: shown read-only with a Copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(false); }
  };
  return (
    <div className="field copy-field">
      <span>{label}</span>
      <div className="copy-row">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-line" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <span aria-live="polite" className="visually-hidden">{copied ? `${label} copied` : ""}</span>
    </div>
  );
}
