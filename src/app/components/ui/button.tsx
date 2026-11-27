import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import Link from "next/link";
import { cx } from "./cx";

/**
 * M3 Expressive's common buttons (docs/agents/ui.md): filled (the club's primary, one per area), tonal (the secondary
 * container: a row's or a second action), outlined (a secondary action standing alone), text (the least: Cancel, Clear),
 * danger (removes or ends something: outlined in the late color) and danger-filled (that action inside its ConfirmDialog).
 */
export type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "danger" | "danger-filled";
/** sm and md are M3's small (40px drawn in a 48px target; sm with less padding), lg its medium (56px: a page's main button). */
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string | null> = { filled: null, tonal: "btn-tonal", outlined: "btn-outlined", text: "btn-text", danger: "btn-danger", "danger-filled": "btn-danger-filled" };

/** The class a button of this variant and size wears: "btn", "btn btn-outlined", "btn btn-text btn-sm" and so on. */
export const buttonClass = (variant: ButtonVariant = "filled", size: ButtonSize = "md", className?: string) =>
  cx("btn", VARIANT[variant], size === "sm" && "btn-sm", size === "lg" && "btn-lg", className);

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
  variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode;
  /** Working: drawn disabled with a spinner and aria-disabled (never `disabled`, which drops the focus). The caller ignores presses while busy. */
  busy?: boolean;
  /** For a button the focus goes back to (a Cancel that draws it again). */
  ref?: Ref<HTMLButtonElement>;
};

/** A button: filled (the club's primary, one per area), tonal, outlined, text, danger or danger-filled. */
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
