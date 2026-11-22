import { cx } from "./cx";

/**
 * A one-line status in words, with a small dot before them that only repeats their tone: the Settings rail's items and
 * the Integrations page's rows ("Connected", "Not set up"). The words carry the state; the dot is hidden from a screen
 * reader. Three tones: done (green: working or set), due (amber: needs attention) and neutral (gray: off or not set up).
 * Use StatusBadge where a state stands on its own; this is for a quiet line beside a name.
 */
export function StatusDot({ tone, words, className }: { tone: "done" | "due" | "neutral"; words: string; className?: string }) {
  return <span className={cx("status-dot", `tone-${tone}`, className)}><span className="dot" aria-hidden="true" />{words}</span>;
}
