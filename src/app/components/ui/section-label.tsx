import type { ReactNode } from "react";

/** The small quiet heading over a List or a table ("To do", "Students"): a real heading, drawn small. */
export function SectionLabel({ id, level = 2, children }: { id?: string; level?: 2 | 3; children: ReactNode }) {
  const H = level === 3 ? "h3" : "h2";
  return <H id={id} className="section-label">{children}</H>;
}
