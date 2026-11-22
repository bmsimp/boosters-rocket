import type { ReactNode } from "react";

/** What isn't there yet ("No events yet"), said kindly, with what happens next or the one action that fills it. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M3 13l2.5-7h13L21 13v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></svg>
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
      {action}
    </div>
  );
}
