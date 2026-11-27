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
 * M3 modal side sheet that fills a phone's screen and slides in from the right from 600px, for a form; and
 * ConfirmDialog, M3's basic dialog, small and centered, for one press that needs a second look. While one is open the
 * page doesn't scroll.
 *
 * A dialog drawn open on the server (a Drawer whose address was loaded) keeps that first `open` for good: React never
 * touches the attribute again, so the effect alone opens and closes it, and without JavaScript it is a plain open
 * <dialog> in the page, drawn as part of it.
 */

/** A side sheet's close, an M3 icon button: the cross, named "Close" in words a screen reader reads. */
const CLOSE = <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg><span className="visually-hidden">Close</span></>;
/** A destructive dialog's icon. */
const ALERT = <svg className="sheet-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5 21.5 20h-19z" /><path d="M12 10v4.5M12 17.5v.01" strokeLinecap="round" /></svg>;

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
  /** A dialog's icon, centered over its title (a destructive ConfirmDialog's alert). */
  icon?: ReactNode;
  /** A Drawer that docks from 1600px: there a pane beside the page, not a modal (see Drawer's `dock`). */
  dock?: boolean;
  children?: ReactNode;
};

/** Where a docking Drawer is a pane beside the page instead of a modal side sheet: M3's extra-large window. */
export const DOCK_MEDIA = "(min-width: 1600px)";

/** Whether the window is wide enough to dock, kept current as it is resized; false on the server and for `off`. */
function useDocks(on: boolean): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (!on || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(DOCK_MEDIA);
    const read = () => setWide(m.matches);
    read();
    m.addEventListener("change", read);
    return () => m.removeEventListener("change", read);
  }, [on]);
  return on && wide;
}

export function Sheet({ open, onClose, title, description, kind = "drawer", closeHref, returnFocusId, footer, icon, dock = false, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descId = useId();
  const [drawnOpen] = useState(open); // the server's answer, kept as it was (see above)
  const back = useRef<HTMLElement | null>(null);
  const held = useRef(false); // whether this dialog holds the page still, so an unmount while open lets it go
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  const docked = useDocks(dock && kind === "drawer");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const modal = d.matches(":modal");
    if (open && docked) {
      // Docked: a pane beside the page, which stays usable. A modal one (the window just grew) is opened again as a pane.
      if (held.current) { held.current = false; holdScroll(false); }
      if (modal) d.close();
      if (!d.open) {
        if (!modal) back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        d.show();
        (d.querySelector<HTMLElement>("[data-autofocus]") ?? d.querySelector<HTMLElement>(".sheet-close"))?.focus();
      }
    } else if (open && !modal) {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (d.open) d.close(); // drawn open in the page: open it again as a dialog
      d.showModal();
      if (!held.current) { held.current = true; holdScroll(true); }
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && (modal || (docked && d.open))) {
      d.close();
      if (held.current) { held.current = false; holdScroll(false); }
      const to = (returnFocusId && document.getElementById(returnFocusId)) || back.current;
      if (to?.isConnected) to.focus();
    }
  }, [open, returnFocusId, docked]);
  useEffect(() => () => { if (held.current) { held.current = false; holdScroll(false); } }, []);

  const close = (e?: MouseEvent) => { e?.preventDefault(); closeRef.current(); };
  // Tab from the last control goes round to the first, and Shift+Tab from the first to the last, so the focus never
  // leaves an open dialog for the browser's own bar (which a modal <dialog> alone allows).
  const keepFocusIn = (e: KeyboardEvent<HTMLDialogElement>) => {
    // A docked pane isn't modal, so the browser sends no cancel for Esc: it closes it here, as Esc closes the sheet.
    if (e.key === "Escape" && docked && !e.defaultPrevented && ref.current?.open && !ref.current.matches(":modal")) { e.preventDefault(); closeRef.current(); return; }
    if (e.key !== "Tab" || e.defaultPrevented || !ref.current?.matches(":modal")) return;
    if ((e.target as HTMLElement).closest("dialog") !== ref.current) return; // a dialog opened from this one keeps its own
    const stops = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("dialog:not([open])") && el.getClientRects().length > 0);
    if (stops.length === 0) return;
    const first = stops[0]!, last = stops[stops.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <dialog ref={ref} open={drawnOpen || undefined} className={cx("sheet", kind === "confirm" ? "sheet-confirm" : "sheet-drawer", dock && kind === "drawer" && "sheet-dock")}
      aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
      onCancel={(e) => { e.preventDefault(); closeRef.current(); }} onKeyDown={keepFocusIn}>
      <div className="sheet-head">
        {icon}
        <h2 id={titleId}>{title}</h2>
        {kind === "drawer" && (closeHref !== undefined
          ? <a className="icon-btn sheet-close" href={closeHref} onClick={close}>{CLOSE}</a>
          : <button type="button" className="icon-btn sheet-close" onClick={() => close()}>{CLOSE}</button>)}
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
 *
 * `dock`: from 1600px wide (M3's extra-large window) the open Drawer is a pane docked beside the page, at the same
 * address, and the page beside it stays usable (its content makes room); below 1600px it is the modal side sheet. Its
 * Close, Esc and Back close it either way.
 */
export function Drawer({ param, value = "1", label, title, description, variant = "outlined", size, triggerClassName, trigger = true, alsoClear = [], footer, dock = false, children }: {
  param: string; value?: string; label: ReactNode; title?: ReactNode; description?: ReactNode;
  variant?: ButtonVariant; size?: ButtonSize; triggerClassName?: string;
  /** False when the Drawer is opened only from elsewhere: a `DrawerLink`, or a link to its address. */
  trigger?: boolean;
  /** Other parts of the address that belong to this Drawer (a search inside it), taken out with its own on close. */
  alsoClear?: string[];
  /** Buttons along the sheet's foot, at 56px: the Drawer's main press and the one beside it. */
  footer?: ReactNode;
  /** From 1600px a pane docked beside the page at the same address, instead of the modal side sheet. */
  dock?: boolean;
  children: ReactNode;
}) {
  const search = useSearchParams();
  const pathname = usePathname();
  const open = search?.get(param) === value;
  const href = withParam(search, param, value, pathname);
  const cleared = new URLSearchParams(search ? search.toString() : "");
  for (const p of alsoClear) cleared.delete(p);
  const closeHref = withParam(cleared, param, null, pathname);
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
      {trigger && <a id={triggerId} className={buttonClass(variant, size, triggerClassName)} href={href} onClick={onOpen}>{label}</a>}
      <Sheet open={open} onClose={onClose} title={title ?? label} description={description} closeHref={closeHref} returnFocusId={trigger ? triggerId : undefined}
        footer={footer} dock={dock}>{children}</Sheet>
    </>
  );
}

/**
 * A second way into a Drawer drawn elsewhere on the page (one with `trigger={false}`, or beside its own button): a
 * link to the page's address with `?param=value`, pushed without a load as the Drawer's own button is, so Back and its
 * Close behave the same.
 */
export function DrawerLink({ param, value, variant = "outlined", size, className, children }: {
  param: string; value: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode;
}) {
  const search = useSearchParams();
  const pathname = usePathname();
  const href = withParam(search, param, value, pathname);
  const onOpen = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    pushedBy = `${param}=${value}`;
    window.history.pushState(null, "", href);
  };
  return <a className={buttonClass(variant, size, className)} href={href} onClick={onOpen}>{children}</a>;
}

export type Confirmed = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * One press that needs a second look (Disconnect QuickBooks, Remove this credit): a button that opens M3's basic dialog
 * with one sentence of what follows, an optional box that must be ticked, and two buttons at its end: Cancel, a text
 * button that takes the focus first, and the action in its own words (filled; in the late color for a destructive one,
 * with the alert icon over the title). The answer of a press that went through is shown beside the button, and of
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
      <Sheet open={open} kind="confirm" title={title ?? `${label}?`} icon={variant === "danger" ? ALERT : undefined} onClose={() => { if (!pending) setOpen(false); }} footer={
        <>
          <Button variant="text" data-autofocus onClick={() => { if (!pending) setOpen(false); }}>Cancel</Button>
          <Button variant={variant === "danger" ? "danger-filled" : "filled"} busy={pending} aria-disabled={unusable || undefined} onClick={press}>{pending ? busyLabel : (confirmLabel ?? label)}</Button>
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
