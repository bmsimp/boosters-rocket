import type { ReactNode } from "react";

/** One figure with its label ("Owed by families", $1,240.00) and an optional line under it. Group several in `.stats`. */
export function Stat({ label, value, meta }: { label: ReactNode; value: ReactNode; meta?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {meta && <span className="stat-meta">{meta}</span>}
    </div>
  );
}
