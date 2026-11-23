"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { EditorIcon, type EditorIconName } from "./icons";

/*
 * The editor's toolbar, after the toolbar of Tiptap's Simple Editor template (its tiptap-ui-primitive toolbar, button
 * and separator, MIT, Copyright (c) 2025 Tiptap; ./LICENSE): groups of icon buttons with a hairline between them, one
 * stop for the Tab key, the arrow keys moving along it (the toolbar pattern of the WAI-ARIA practices, as the
 * template's own does). Drawn with booster.css's "Rich text editor" block: 44px buttons, the club's tint on a button
 * that is on, the club's ring on the one that has the focus.
 */

const TOOLS = "button.rte-tool";

/** A row of groups of buttons, named for screen readers (`label`), that wraps on a phone. */
export function EditorToolbar({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(TOOLS) ?? [])];
  /** The one button the Tab key stops at: the one last focused, or the first. */
  const stopAt = (b: HTMLButtonElement | undefined) => { for (const x of buttons()) x.tabIndex = x === b ? 0 : -1; };

  useEffect(() => { if (!ref.current?.querySelector(`${TOOLS}[tabindex="0"]`)) stopAt(buttons()[0]); });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const all = buttons();
    const t: EventTarget = e.target;
    const at = t instanceof HTMLButtonElement ? all.indexOf(t) : -1;
    if (at < 0) return;
    const to = e.key === "ArrowRight" ? (at + 1) % all.length : e.key === "ArrowLeft" ? (at - 1 + all.length) % all.length
      : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    stopAt(all[to]);
    all[to]!.focus();
  }

  return (
    <div ref={ref} className="rte-toolbar" role="toolbar" aria-label={label} onKeyDown={onKeyDown}
      onFocus={(e) => { const t: EventTarget = e.target; if (t instanceof HTMLButtonElement && t.matches(TOOLS)) stopAt(t); }}>
      {children}
    </div>
  );
}

/** Buttons that belong together (the marks, the lists), a hairline before the next group. */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="rte-group">{children}</div>;
}

/**
 * One button: its drawing, and its name in words (`label`), which a screen reader reads and a pointer shows on hover.
 * `pressed` for one that is on or off where the cursor is (Bold); `unavailable` for one that can't act now (Undo with
 * nothing to undo): aria-disabled, never disabled, so it keeps its place for the arrow keys. It never takes the focus
 * from the writing area on a press, so the words selected stay selected. One that opens a panel says so (`expanded`,
 * `controls`) and is drawn on while the cursor is in what it changes (`active`: a link).
 */
export function ToolButton({ icon, label, pressed, unavailable, expanded, controls, active, onPress }: {
  icon: EditorIconName; label: string; pressed?: boolean; unavailable?: boolean; expanded?: boolean; controls?: string; active?: boolean; onPress: () => void;
}) {
  return (
    <button type="button" className="rte-tool" tabIndex={-1} aria-label={label} title={label} data-on={pressed || expanded || active ? "true" : undefined}
      aria-pressed={pressed} aria-disabled={unavailable || undefined} aria-expanded={expanded} aria-controls={controls}
      onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!unavailable) onPress(); }}>
      <EditorIcon name={icon} />
    </button>
  );
}
