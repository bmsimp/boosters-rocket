import { Fragment, type LiHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { StatusIcon } from "./status-icon";
import type { Tone } from "./tone";

/** A bordered list of like rows (To do, Students, Payments). Inside a Card it runs to the card's edges. */
export function List({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return <ul className={cx("list", className)} aria-label={label}>{children}</ul>;
}

/**
 * One row of a List: a leading status (its icon, and its words at the start of the meta line), the title, a meta
 * line, then an amount and an action at the end. The action is a compact Button or LinkButton (size "sm"). A status
 * with no words of its own draws only its icon, for a row whose meta line already says the state (an invoice's due
 * line). `meta` may be a list of parts, each drawn with a dot between it and the next, the empty ones left out.
 * `sub` holds ListSubRow rows, indented under the row on its own surface, a hairline between each: the parts of one
 * thing (a student's requirements), never a card inside a card. `detail` is what belongs under the row at its full
 * width, indented to the title: a note about it, or the small form that takes the place of its action (a passkey's new
 * name). Any other attribute (a `data-*` hook) goes on the row's `li`.
 */
export function ListRow({ status, title, meta, amount, action, sub, detail, className, ...li }: {
  status?: { tone: Tone; words?: string }; title: ReactNode; meta?: ReactNode | ReactNode[]; amount?: ReactNode; action?: ReactNode; sub?: ReactNode;
  detail?: ReactNode; className?: string;
} & Omit<LiHTMLAttributes<HTMLLIElement>, "title" | "className" | "children">) {
  const words = status?.words;
  const parts = (Array.isArray(meta) ? meta : [meta]).filter((m) => m !== undefined && m !== null && m !== false && m !== "");
  const dot = <span aria-hidden="true"> · </span>;
  return (
    <li className={cx("list-row", (sub !== undefined || Boolean(detail)) && "has-sub", className)} {...li}>
      {status && <StatusIcon tone={status.tone} />}
      <div className="list-main">
        <span className="list-title">{title}</span>
        {(words || parts.length > 0) && (
          <span className="list-meta">
            {words && <span className={`list-status tone-${status!.tone}`}>{words}</span>}
            {parts.map((part, i) => <Fragment key={i}>{(words || i > 0) && dot}{part}</Fragment>)}
          </span>
        )}
      </div>
      {(amount !== undefined || action) && (
        <div className="list-trail">{amount !== undefined && <span className="list-amount num">{amount}</span>}{action}</div>
      )}
      {Boolean(detail) && <div className="list-detail">{detail}</div>}
      {sub !== undefined && <ul className="list-sub">{sub}</ul>}
    </li>
  );
}

/** One indented row under a ListRow (its `sub`): a title over a meta line, on the row's own surface. */
export function ListSubRow({ title, meta, className }: { title: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <li className={cx("list-subrow", className)}>
      <span className="list-sub-title">{title}</span>
      {meta && <span className="list-meta">{meta}</span>}
    </li>
  );
}

/**
 * The total under a List of amounts (Payments' open invoices): its label and the sum, on the muted surface, right after
 * the list. A list followed by one draws each row's amount last, after its action, so the figures make one column with
 * the total.
 */
export function ListTotal({ label, amount, className }: { label: ReactNode; amount: ReactNode; className?: string }) {
  return <div className={cx("list-total", className)}><span>{label}</span><span className="list-amount num">{amount}</span></div>;
}
