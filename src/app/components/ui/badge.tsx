import type { ReactNode } from "react";
import { cx } from "./cx";
import { StatusIcon } from "./status-icon";
import { TONE_WORD, type Tone } from "./tone";

/** A short label on a soft tint ("Admin", "3 waiting"): words first, tone optional. Use StatusBadge for a state. */
export function Badge({ tone, children, className }: { tone?: Tone | "club"; children: ReactNode; className?: string }) {
  return <span className={cx("badge", tone && tone !== "neutral" && `badge-${tone}`, className)}>{children}</span>;
}

/** A state as a badge: its tone's icon and its words ("Paid", "2 to sign"); the tone's own word when none is given. */
export function StatusBadge({ tone, children, className }: { tone: Tone; children?: ReactNode; className?: string }) {
  return (
    <Badge tone={tone} className={className}>
      <StatusIcon tone={tone} />{children ?? TONE_WORD[tone]}
    </Badge>
  );
}
