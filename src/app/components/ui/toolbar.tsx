import type { ReactNode } from "react";

/** A row of filters (fields, selects, a search) over the list or table they scope, with actions at its end. */
export function Toolbar({ label, children, end }: { label: string; children: ReactNode; end?: ReactNode }) {
  return (
    <div className="toolbar" role="group" aria-label={label}>
      {children}
      {end && <div className="toolbar-end">{end}</div>}
    </div>
  );
}
