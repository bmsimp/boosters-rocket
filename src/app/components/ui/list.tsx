import type { ReactNode } from "react";
import { cx } from "./cx";
import { StatusIcon } from "./status-icon";
import type { Tone } from "./tone";

/** A bordered list of like rows (To do, Students, Payments). Inside a Card it runs to the card's edges. */
export function List({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return <ul className={cx("list", className)} aria-label={label}>{children}</ul>;
}

/**
 * One row of a List: a leading status (its icon, and its words at the start of the meta line), the title, a meta
 * line, then an amount and an action at the end. The action is a compact Button or LinkButton (size "sm").
 */
export function ListRow({ status, title, meta, amount, action, className }: {
  status?: { tone: Tone; words: string }; title: ReactNode; meta?: ReactNode; amount?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <li className={cx("list-row", className)}>
      {status && <StatusIcon tone={status.tone} />}
      <div className="list-main">
        <span className="list-title">{title}</span>
        {(status || meta) && (
          <span className="list-meta">
            {status && <span className={`list-status tone-${status.tone}`}>{status.words}</span>}
            {status && meta && <span aria-hidden="true"> · </span>}
            {meta}
          </span>
        )}
      </div>
      {(amount !== undefined || action) && (
        <div className="list-trail">{amount !== undefined && <span className="list-amount num">{amount}</span>}{action}</div>
      )}
    </li>
  );
}
