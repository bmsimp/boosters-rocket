import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import Link from "next/link";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "club";
export type ButtonSize = "md" | "sm";

const VARIANT: Record<ButtonVariant, string | null> = { primary: null, secondary: "btn-line", quiet: "btn-quiet", danger: "btn-danger", club: "btn-club" };

/** The class a button of this variant and size wears: "btn", "btn btn-line", "btn btn-quiet btn-sm" and so on. */
export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) =>
  cx("btn", VARIANT[variant], size === "sm" && "btn-sm", className);

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
  variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode;
  /** Working: drawn disabled with a spinner and aria-disabled (never `disabled`, which drops the focus). The caller ignores presses while busy. */
  busy?: boolean;
  /** For a button the focus goes back to (a Cancel that draws it again). */
  ref?: Ref<HTMLButtonElement>;
};

/** A button: primary (the club's fill, one per area), secondary, quiet (words), danger (removes or ends something), or club (tinted). */
export function Button({ variant, size, className, busy = false, children, type = "button", "aria-disabled": ariaDisabled, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} aria-disabled={busy || ariaDisabled || undefined} {...rest}>
      {busy && <span className="btn-spinner" aria-hidden="true" />}{children}
    </button>
  );
}

type LinkButtonProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href" | "children"> & {
  variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode;
} & (
  | { href: string; plain?: false }
  /** A plain <a> (a full page load, a link off the portal such as QuickBooks' payment page, or a paused one with no address) instead of Next's Link. */
  | { href?: string; plain: true }
);

/** A link drawn as a button: for going somewhere, where Button is for doing something. */
export function LinkButton({ variant, size, className, plain, href, children, ...rest }: LinkButtonProps) {
  const cls = buttonClass(variant, size, className);
  if (plain || href === undefined) return <a className={cls} href={href} {...rest}>{children}</a>;
  return <Link className={cls} href={href} {...rest}>{children}</Link>;
}
