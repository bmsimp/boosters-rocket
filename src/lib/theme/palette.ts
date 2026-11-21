/**
 * The fixed colors of the visual system, by display mode, as `src/app/booster.css` defines them in its token blocks.
 * The stylesheet is what the browser reads; this copy is what the contrast checks, the design-system gallery and the
 * browser's theme color read. `tests/unit/design-tokens.test.ts` fails when the two disagree, and when any text and
 * ground pair below falls under its floor (4.5:1 for text, 7:1 in high contrast, 3:1 for a control's edge or a drawn
 * mark). The club's own color is not here: it is derived at runtime (`deriveClubTokens()`, ./contrast.ts).
 */
export type Mode = "light" | "dark" | "lightHc" | "darkHc";

export const PALETTE = {
  light: {
    ground: "#f7f7f8", surface: "#ffffff", "surface-raised": "#ffffff", "surface-muted": "#f2f2f4",
    border: "#e3e4e8", "border-control": "#cfd2d8", "border-strong": "#8a8e98",
    ink: "#18191d", "ink-2": "#5c606a", "ink-3": "#8a8e98",
    done: "#1d7344", due: "#955400", late: "#b3261e", info: "#3f5a8a",
    "done-soft": "#e7f4ec", "due-soft": "#fcf1df", "late-soft": "#fceceb", "info-soft": "#edf1f8", "neutral-soft": "#f0f1f3",
  },
  dark: {
    ground: "#0f1012", surface: "#16181c", "surface-raised": "#1e2025", "surface-muted": "#1e2025",
    border: "#2a2d33", "border-control": "#3b3f46", "border-strong": "#6f737d",
    ink: "#ececee", "ink-2": "#a2a6ae", "ink-3": "#6f737d",
    done: "#5fc68b", due: "#e9a647", late: "#ff8b7d", info: "#93b4ef",
    "done-soft": "#15291e", "due-soft": "#2e2312", "late-soft": "#33191a", "info-soft": "#18233a", "neutral-soft": "#22252a",
  },
  lightHc: {
    ground: "#ffffff", surface: "#ffffff", "surface-raised": "#ffffff", "surface-muted": "#f2f2f4",
    border: "#18191d", "border-control": "#18191d", "border-strong": "#18191d",
    ink: "#000000", "ink-2": "#2b2e34", "ink-3": "#2b2e34",
    done: "#0f5530", due: "#6b3a00", late: "#8a1a14", info: "#23406e",
    "done-soft": "#e7f4ec", "due-soft": "#fcf1df", "late-soft": "#fceceb", "info-soft": "#edf1f8", "neutral-soft": "#f0f1f3",
  },
  darkHc: {
    ground: "#000000", surface: "#000000", "surface-raised": "#141518", "surface-muted": "#141518",
    border: "#ececee", "border-control": "#ececee", "border-strong": "#ececee",
    ink: "#ffffff", "ink-2": "#e2e4e8", "ink-3": "#e2e4e8",
    done: "#8eeab1", due: "#ffc978", late: "#ffb0a6", info: "#bcd2fb",
    "done-soft": "#15291e", "due-soft": "#2e2312", "late-soft": "#33191a", "info-soft": "#18233a", "neutral-soft": "#22252a",
  },
} as const satisfies Record<Mode, Record<string, string>>;

export type Token = keyof (typeof PALETTE)["light"];

/** Every text color the system sets on every ground it sets it on. Text floors: 4.5:1, or 7:1 in high contrast. */
export const TEXT_PAIRS: readonly [fg: Token, bg: Token][] = [
  ...(["ink", "ink-2", "done", "due", "late", "info"] as const).flatMap((fg) =>
    (["ground", "surface", "surface-raised", "surface-muted"] as const).map((bg) => [fg, bg] as [Token, Token])),
  ["done", "done-soft"], ["due", "due-soft"], ["late", "late-soft"], ["info", "info-soft"],
  ["ink", "done-soft"], ["ink", "due-soft"], ["ink", "late-soft"], ["ink", "info-soft"],
  ["ink-2", "neutral-soft"], ["ink", "neutral-soft"],
];

/** Marks that are not text but must be seen: a text field's edge, a check box, an upcoming status ring. 3:1. */
export const MARK_PAIRS: readonly [fg: Token, bg: Token][] = [["border-strong", "surface"], ["border-strong", "ground"], ["ink-3", "surface"]];

/**
 * The grounds the club's color is checked against when it is used as text, a link or the focus ring: the darkest light
 * ground (the muted hover fill) and the lightest dark one, so it passes on every surface of its mode.
 */
export const CLUB_TEXT_GROUND = { light: PALETTE.light["surface-muted"], dark: PALETTE.dark["surface-muted"], lightHc: PALETTE.lightHc["surface-muted"], darkHc: PALETTE.darkHc["surface-muted"] } as const;
/** The surface the club's tint is mixed into, per theme. */
export const CLUB_TINT_SURFACE = { light: PALETTE.light.surface, dark: PALETTE.dark.surface } as const;

/** The browser's theme color: the top bar's white surface in light, the dark surface in dark. */
export const THEME_COLOR = { light: PALETTE.light.surface, dark: PALETTE.dark.surface } as const;
