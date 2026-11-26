"use client";
import { startTransition, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button, buttonClass, type ButtonSize, type ButtonVariant } from "./button";
import { cx } from "./cx";
import { Checkbox, TextArea } from "./field";
import { ActionOutcome } from "../notice";
import { ACTION_FAILED, safely } from "../action-error";

/**
 * The portal's dialogs, on the native <dialog> and showModal(): the browser makes the page behind inert, keeps the focus
 * inside, and closes on Esc (the `cancel` event, which is sent to the caller's close instead). Two sizes: a Drawer, a
 * side sheet that fills a phone's screen and slides in from the right on a wider one, for a form; and ConfirmDialog,
 * small and centered, for one press that needs a second look. While one is open the page doesn't scroll.
 *
 * A dialog drawn open on the server (a Drawer whose address was loaded) keeps that first `open` for good: React never
 * touches the attribute again, so the effect alone opens and closes it, and without JavaScript it is a plain open
 * <dialog> in the page, drawn as part of it.
 */

/** How many dialogs are open: the page keeps still while any is. */
let openCount = 0;
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
function holdScroll(on: boolean) {
  openCount = Math.max(0, openCount + (on ? 1 : -1));
  document.documentElement.classList.toggle("sheet-open", openCount > 0);
}

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One or two sentences under the title: what this does, or what a press can't undo. */
  description?: ReactNode;
  kind?: "drawer" | "confirm";
  /** Where Close goes without JavaScript (a Drawer's address without its own part). Given, Close is a link. */
  closeHref?: string;
  /** The element the focus goes back to on close, when it isn't the one focused when the dialog opened. */
  returnFocusId?: string;
  /** Buttons along the dialog's foot (ConfirmDialog's two). */
  footer?: ReactNode;
  children?: ReactNode;
};

export function Sheet({ open, onClose, title, description, kind = "drawer", closeHref, returnFocusId, footer, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descId = useId();
  const [drawnOpen] = useState(open); // the server's answer, kept as it was (see above)
  const back = useRef<HTMLElement | null>(null);
  const held = useRef(false); // whether this dialog holds the page still, so an unmount while open lets it go
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const modal = d.matches(":modal");
    if (open && !modal) {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (d.open) d.close(); // drawn open in the page: open it again as a dialog
      d.showModal();
      if (!held.current) { held.current = true; holdScroll(true); }
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && modal) {
      d.close();
      if (held.current) { held.current = false; holdScroll(false); }
      const to = (returnFocusId && document.getElementById(returnFocusId)) || back.current;
      if (to?.isConnected) to.focus();
    }
  }, [open, returnFocusId]);
  useEffect(() => () => { if (held.current) { held.current = false; holdScroll(false); } }, []);

  const close = (e?: MouseEvent) => { e?.preventDefault(); closeRef.current(); };
  // Tab from the last control goes round to the first, and Shift+Tab from the first to the last, so the focus never
  // leaves an open dialog for the browser's own bar (which a modal <dialog> alone allows).
  const keepFocusIn = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || e.defaultPrevented || !ref.current?.matches(":modal")) return;
    if ((e.target as HTMLElement).closest("dialog") !== ref.current) return; // a dialog opened from this one keeps its own
    const stops = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("dialog:not([open])") && el.getClientRects().length > 0);
    if (stops.length === 0) return;
    const first = stops[0]!, last = stops[stops.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <dialog ref={ref} open={drawnOpen || undefined} className={cx("sheet", kind === "confirm" ? "sheet-confirm" : "sheet-drawer")}
      aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
      onCancel={(e) => { e.preventDefault(); closeRef.current(); }} onKeyDown={keepFocusIn}>
      <div className="sheet-head">
        <h2 id={titleId}>{title}</h2>
        {kind === "drawer" && (closeHref !== undefined
          ? <a className={buttonClass("quiet", "sm", "sheet-close")} href={closeHref} onClick={close}>Close</a>
          : <Button variant="quiet" size="sm" className="sheet-close" onClick={() => close()}>Close</Button>)}
      </div>
      <div className="sheet-body">
        {description && <p id={descId} className="sheet-desc">{description}</p>}
        {children}
      </div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </dialog>
  );
}

/** The search string with `param` set to `value` (or taken out, for null), as a relative address. */
export function withParam(search: URLSearchParams | null, param: string, value: string | null, pathname: string | null): string {
  const next = new URLSearchParams(search ? search.toString() : "");
  if (value === null) next.delete(param); else next.set(param, value);
  const qs = next.toString();
  return qs ? `?${qs}` : (pathname ?? "?");
}

/** The Drawer the last press opened, so its Close goes back a step in the history instead of adding one. */
let pushedBy: string | null = null;
/** How many Drawers of each address are drawn now. */
const mounted = new Map<string, number>();

/**
 * A form behind a button: the button (a link to the page's own address with `?param=value`) opens a Drawer holding
 * it. The address is the Drawer's: Back closes it, a refresh opens it again, and without JavaScript the link loads the
 * page with the form drawn in it. The form is drawn on the server either way, so it is its own server action with
 * every check it had. `label` says what the form does ("Waive for Sam Rivera"); the title is the label unless given.
 */
export function Drawer({ param, value = "1", label, title, description, variant = "secondary", size, triggerClassName, children }: {
  param: string; value?: string; label: ReactNode; title?: ReactNode; description?: ReactNode;
  variant?: ButtonVariant; size?: ButtonSize; triggerClassName?: string; children: ReactNode;
}) {
  const search = useSearchParams();
  const pathname = usePathname();
  const open = search?.get(param) === value;
  const href = withParam(search, param, value, pathname);
  const closeHref = withParam(search, param, null, pathname);
  const key = `${param}=${value}`;
  const triggerId = `drawer-${param}-${value}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const onOpen = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab or window loads it as a page
    e.preventDefault();
    pushedBy = key;
    window.history.pushState(null, "", href);
  };
  const onClose = () => {
    if (pushedBy === key) { pushedBy = null; window.history.back(); }
    else window.history.replaceState(null, "", closeHref);
  };
  // Drawn away while open (its row changed: a waiver saved), it takes its part out of the address, so nothing else
  // opens it later; but only while the page is still this one, never on the way to another.
  const live = useRef({ open, closeHref, pathname });
  useEffect(() => { live.current = { open, closeHref, pathname }; });
  useEffect(() => {
    mounted.set(key, (mounted.get(key) ?? 0) + 1);
    return () => {
      mounted.set(key, (mounted.get(key) ?? 1) - 1);
      const l = live.current;
      // After this turn: a remount at once (React's development double run, a row moved) keeps it.
      setTimeout(() => {
        if ((mounted.get(key) ?? 0) > 0 || !l.open) return;
        if (window.location.pathname !== l.pathname || new URLSearchParams(window.location.search).get(param) !== value) return;
        if (pushedBy === key) pushedBy = null;
        window.history.replaceState(null, "", l.closeHref);
      }, 0);
    };
  }, [param, value, key]);
  return (
    <>
      <a id={triggerId} className={buttonClass(variant, size, triggerClassName)} href={href} onClick={onOpen}>{label}</a>
      <Sheet open={open} onClose={onClose} title={title ?? label} description={description} closeHref={closeHref} returnFocusId={triggerId}>{children}</Sheet>
    </>
  );
}

export type Confirmed = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * One press that needs a second look (Disconnect QuickBooks, Remove this credit): a button that opens a small dialog
 * with one sentence of what follows, an optional box that must be ticked, and two buttons, the action's own words and
 * Cancel (which takes the focus first). The answer of a press that went through is shown beside the button, and of
 * one that didn't, in the dialog. `act` is the server action, called with no argument (or, with `reason`, the words
 * typed): the box gates the press here, and an action that needs it on the server too is wrapped by its caller.
 */
export function ConfirmDialog({ label, context, title, consequence, check, reason, confirmLabel, busyLabel = "Working…", variant = "danger", size, answerHere = true, act, children }: {
  label: string;
  /** Words for a screen reader after the label, so a row's button names its row ("Give up on this change: Rivera Family"). */
  context?: string;
  title?: ReactNode; consequence: ReactNode; check?: string;
  /** A few words the press needs (a note for the audit log): one field, sent as `act`'s one argument. */
  reason?: { label: string; maxLength: number };
  confirmLabel?: string; busyLabel?: string;
  variant?: ButtonVariant; size?: ButtonSize;
  /** False when the caller shows a press's answer itself (above a list the row leaves): this one then says nothing of a success. */
  answerHere?: boolean;
  act: (() => Promise<Confirmed>) | ((text: string) => Promise<Confirmed>); children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<Confirmed | null>(null);
  const boxId = useId(), reasonId = useId();
  const unusable = pending || (check !== undefined && !ticked);
  const press = () => {
    if (unusable) return;
    setPending(true);
    startTransition(async () => {
      // With no field the action is called with no argument at all: a server action refuses one it doesn't take.
      const r = await safely(() => (reason ? (act as (t: string) => Promise<Confirmed>)(text) : (act as () => Promise<Confirmed>)()), { ok: false as const, errors: [ACTION_FAILED] });
      setPending(false);
      setAnswer(r);
      if (r.ok) { setOpen(false); setTicked(false); setText(""); }
    });
  };
  return (
    <div className="confirm">
      <Button variant={variant} size={size} onClick={() => { setAnswer(null); setOpen(true); }}>{label}{context && <span className="visually-hidden">: {context}</span>}</Button>
      {answerHere && answer?.ok && <ActionOutcome state={answer} />}
      <Sheet open={open} kind="confirm" title={title ?? `${label}?`} onClose={() => { if (!pending) setOpen(false); }} footer={
        <>
          <Button variant={variant === "danger" ? "danger" : "primary"} busy={pending} aria-disabled={unusable || undefined} onClick={press}>{pending ? busyLabel : (confirmLabel ?? label)}</Button>
          <Button variant="secondary" data-autofocus onClick={() => { if (!pending) setOpen(false); }}>Cancel</Button>
        </>
      }>
        <p>{consequence}</p>
        {children}
        {reason && <TextArea id={reasonId} label={reason.label} rows={2} maxLength={reason.maxLength} value={text} onChange={(e) => setText(e.target.value)} />}
        {check !== undefined && (
          <Checkbox id={boxId} label={check} checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        )}
        {answer && !answer.ok && <ActionOutcome state={answer} />}
      </Sheet>
    </div>
  );
}
