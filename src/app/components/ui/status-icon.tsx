import { cx } from "./cx";
import type { Tone } from "./tone";

/**
 * The small ring before a row or inside a badge: its shape tells the tone as well as its color does (done a filled
 * circle with a tick, due a clock, late a filled circle with an alert bar, info a filled circle with an i, neutral a
 * dashed ring). Decoration: the row's words say the state, so it is hidden from screen readers.
 */
export function StatusIcon({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <svg className={cx("status-icon", `tone-${tone}`, className)} viewBox="0 0 16 16" aria-hidden="true">
      {tone === "done" && <><circle cx="8" cy="8" r="7" fill="currentColor" /><path className="status-mark" d="M4.8 8.3l2.1 2.1 4.3-4.5" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>}
      {tone === "due" && <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 4.9V8l2.2 1.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>}
      {tone === "late" && <><circle cx="8" cy="8" r="7" fill="currentColor" /><path className="status-mark" d="M8 4.6v4.2M8 11.2v.1" fill="none" strokeWidth="1.9" strokeLinecap="round" /></>}
      {tone === "info" && <><circle cx="8" cy="8" r="7" fill="currentColor" /><path className="status-mark" d="M8 7.4v3.9M8 4.8v.1" fill="none" strokeWidth="1.9" strokeLinecap="round" /></>}
      {tone === "neutral" && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="2.4 2.3" />}
    </svg>
  );
}
