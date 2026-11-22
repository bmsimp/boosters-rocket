import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The longer explanation of a card, folded away under one quiet summary ("How this works"): a details/summary whose
 * summary is a 44px line in the club's text color with a caret that turns when open. The words stay in the page (a
 * search or a screen reader's find still reaches them); what a reader must know before pressing stays outside it.
 */
export function HowThisWorks({ summary = "How this works", className, children }: { summary?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <details className={cx("more how", className)}>
      <summary><svg className="how-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>{summary}</summary>
      <div className="how-body">{children}</div>
    </details>
  );
}
