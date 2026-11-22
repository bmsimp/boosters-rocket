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
    done: "#1f6b3d", due: "#9a4a0b", late: "#a1231a", info: "#3b4cb8",
    "done-soft": "#e3f2e8", "due-soft": "#fdeedc", "late-soft": "#fbe4e2", "info-soft": "#e6e8fa", "neutral-soft": "#f0f1f3",
    "badge-ink": "#6b6b6b",
    "br-ink": "#1e1b4b", "br-flame-ink": "#b82d28", "br-disc": "#1e1b4b", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff",
  },
  dark: {
    ground: "#0f1012", surface: "#16181c", "surface-raised": "#1e2025", "surface-muted": "#1e2025",
    border: "#2a2d33", "border-control": "#3b3f46", "border-strong": "#6f737d",
    ink: "#ececee", "ink-2": "#a2a6ae", "ink-3": "#6f737d",
    done: "#6cc38a", due: "#f2b36b", late: "#ff8a80", info: "#a5adff",
    "done-soft": "#12301f", "due-soft": "#3a2510", "late-soft": "#3d1512", "info-soft": "#1e2250", "neutral-soft": "#22252a",
    "badge-ink": "#9a9aa2",
    "br-ink": "#ffffff", "br-flame-ink": "#f06a5f", "br-disc": "#332f72", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff",
  },
  lightHc: {
    ground: "#ffffff", surface: "#ffffff", "surface-raised": "#ffffff", "surface-muted": "#f2f2f4",
    border: "#18191d", "border-control": "#18191d", "border-strong": "#18191d",
    ink: "#000000", "ink-2": "#2b2e34", "ink-3": "#2b2e34",
    done: "#0f5530", due: "#6b3a00", late: "#8a1a14", info: "#2c3888",
    "done-soft": "#e3f2e8", "due-soft": "#fdeedc", "late-soft": "#fbe4e2", "info-soft": "#e6e8fa", "neutral-soft": "#f0f1f3",
    "badge-ink": "#2b2e34",
    "br-ink": "#000000", "br-flame-ink": "#000000", "br-disc": "#1e1b4b", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff",
  },
  darkHc: {
    ground: "#000000", surface: "#000000", "surface-raised": "#141518", "surface-muted": "#141518",
    border: "#ececee", "border-control": "#ececee", "border-strong": "#ececee",
    ink: "#ffffff", "ink-2": "#e2e4e8", "ink-3": "#e2e4e8",
    done: "#8eeab1", due: "#ffc978", late: "#ffb0a6", info: "#bfc5ff",
    "done-soft": "#12301f", "due-soft": "#3a2510", "late-soft": "#3d1512", "info-soft": "#1e2250", "neutral-soft": "#22252a",
    "badge-ink": "#e2e4e8",
    "br-ink": "#ffffff", "br-flame-ink": "#ffffff", "br-disc": "#332f72", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff",
  },
} as const satisfies Record<Mode, Record<string, string>>;

export type Token = keyof (typeof PALETTE)["light"];

/** Every text color the system sets on every ground it sets it on. Text floors: 4.5:1, or 7:1 in high contrast. */
export const TEXT_PAIRS: readonly [fg: Token, bg: Token][] = [
  ...(["ink", "ink-2", "done", "due", "late", "info"] as const).flatMap((fg) =>
    (["ground", "surface", "surface-raised", "surface-muted"] as const).map((bg) => [fg, bg] as [Token, Token])),
  ["done", "done-soft"], ["due", "due-soft"], ["late", "late-soft"], ["info", "info-soft"],
  ["ink", "done-soft"], ["ink", "due-soft"], ["ink", "late-soft"], ["ink", "info-soft"],
  // the footer's "Powered by Boosters Rocket" badge sits on the page's ground (and the sign-in card's surface)
  ["badge-ink", "ground"], ["badge-ink", "surface"],
  // the sign-in page's full-color badge: the product's name in its own colors (high contrast: in ink)
  ["br-ink", "ground"], ["br-flame-ink", "ground"], ["br-ink", "surface"], ["br-flame-ink", "surface"],
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
