import type { ReactNode } from "react";
import { cx } from "./cx";

type Titled = { title: ReactNode; titleId: string } | { title?: undefined; titleId?: undefined };

/**
 * A card (a `.box` section): a white surface with a hairline edge, its title (which names the region), a quiet line
 * under it, its content, and its actions at the foot. `headActions` puts actions beside the title instead. Lists and
 * tables inside run to its edges. `id` is the card's own, for a link to it (`#staff-google`).
 */
export function Card({ title, titleId, level = 2, description, actions, headActions, className, id, children }: Titled & {
  level?: 2 | 3; description?: ReactNode; actions?: ReactNode; headActions?: ReactNode; className?: string; id?: string; children?: ReactNode;
}) {
  const H = level === 3 ? "h3" : "h2";
  const heading = title !== undefined && <H id={titleId}>{title}</H>;
  const lede = description !== undefined && <p className="card-lede">{description}</p>;
  return (
    <section id={id} className={cx("box", className)} aria-labelledby={titleId}>
      {headActions ? <div className="card-head"><div>{heading}{lede}</div><div className="card-actions">{headActions}</div></div> : <>{heading}{lede}</>}
      {children}
      {actions && <div className="box-foot">{actions}</div>}
    </section>
  );
}
