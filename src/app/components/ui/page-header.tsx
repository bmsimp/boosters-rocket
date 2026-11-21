import type { ReactNode } from "react";
import Link from "next/link";
import { cx } from "./cx";

/** A page's head: the way back (optional), the h1, one quiet line under it, and the page's actions at its end. */
export function PageHeader({ title, lede, actions, back, className }: {
  title: ReactNode; lede?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; className?: string;
}) {
  return (
    <div className={cx("page-head", className)}>
      <div>
        {back && (
          <p className="page-back">
            <Link href={back.href}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>{back.label}</Link>
          </p>
        )}
        <h1 className="page-title">{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
