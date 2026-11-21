import { cx } from "./cx";

/** A person's initials in a circle. Decoration beside their name, so hidden from screen readers. */
export function Avatar({ initials, size = "md", club = false }: { initials: string; size?: "md" | "sm"; club?: boolean }) {
  return <span className={cx("avatar", size === "sm" && "avatar-sm", club && "avatar-club")} aria-hidden="true">{initials}</span>;
}
