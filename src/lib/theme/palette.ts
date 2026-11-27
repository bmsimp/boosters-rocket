/**
 * The fixed colors of the visual system, by display mode, as `src/app/booster.css` defines them in its token blocks.
 * They are Material 3's neutral roles (the surfaces, on-surface, outline) and the brand's four status colors as M3
 * custom color groups (a color, its container), and they are the same for every club: the owner's D1 of 2026-11-26
 * (no club tint on a surface) and brand/BRAND.md (a club never changes the status colors). The club's own roles
 * (primary, secondary, tertiary and their containers) are made at runtime from its color (`clubScheme()`, ./scheme.ts).
 *
 * The stylesheet is what the browser reads; this copy is what the contrast checks, the design-system gallery and the
 * browser's theme color read. `tests/unit/design-tokens.test.ts` fails when the two disagree, and when any text and
 * ground pair below falls under its floor (4.5:1 for text, 7:1 in high contrast, 3:1 for a control's edge or a mark).
 */
export type Mode = "light" | "dark" | "lightHc" | "darkHc";
export const MODES: readonly Mode[] = ["light", "dark", "lightHc", "darkHc"];

const BRAND_LIGHT = { "br-ink": "#1e1b4b", "br-flame-ink": "#b82d28", "br-disc": "#1e1b4b", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff" } as const;
const BRAND_DARK = { "br-ink": "#ffffff", "br-flame-ink": "#f06a5f", "br-disc": "#332f72", "br-flame": "#e8433a", "br-ember": "#f49a92", "br-glow": "#fbd8d4", "br-smoke": "#ffffff" } as const;

export const PALETTE = {
  light: {
    // the page is surface-container; a card is the lowest container (white) on it; the bars are surface
    ground: "#eceef2", surface: "#f7f9fd", card: "#ffffff",
    "surface-container-lowest": "#ffffff", "surface-container-low": "#f1f4f7", "surface-container": "#eceef2",
    "surface-container-high": "#e6e8ec", "surface-container-highest": "#e0e3e6",
    "on-surface": "#1a1c1e", "on-surface-variant": "#42474e", outline: "#72777f", "outline-variant": "#c1c7cf",
    done: "#1f6b3d", due: "#9a4a0b", late: "#a1231a", info: "#3b4cb8", "on-late": "#ffffff",
    "done-container": "#e3f2e8", "due-container": "#fdeedc", "late-container": "#fbe4e2", "info-container": "#e6e8fa", "neutral-container": "#e6e8ec",
    "badge-ink": "#6b6b6b",
    ...BRAND_LIGHT,
  },
  dark: {
    ground: "#111316", surface: "#111316", card: "#1e2022",
    "surface-container-lowest": "#0c0e12", "surface-container-low": "#1a1c1e", "surface-container": "#1e2022",
    "surface-container-high": "#282a2d", "surface-container-highest": "#333538",
    "on-surface": "#e0e3e6", "on-surface-variant": "#c1c7cf", outline: "#8b9199", "outline-variant": "#42474e",
    done: "#6cc38a", due: "#f2b36b", late: "#ff8a80", info: "#a5adff", "on-late": "#3d0602",
    "done-container": "#12301f", "due-container": "#3a2510", "late-container": "#3d1512", "info-container": "#1e2250", "neutral-container": "#282a2d",
    "badge-ink": "#9a9aa2",
    ...BRAND_DARK,
  },
  lightHc: {
    ground: "#ffffff", surface: "#ffffff", card: "#ffffff",
    "surface-container-lowest": "#ffffff", "surface-container-low": "#f7f7f9", "surface-container": "#f2f2f4",
    "surface-container-high": "#ececee", "surface-container-highest": "#e6e6e8",
    "on-surface": "#000000", "on-surface-variant": "#2b2e34", outline: "#18191d", "outline-variant": "#18191d",
    done: "#0f5530", due: "#6b3a00", late: "#8a1a14", info: "#2c3888", "on-late": "#ffffff",
    "done-container": "#e3f2e8", "due-container": "#fdeedc", "late-container": "#fbe4e2", "info-container": "#e6e8fa", "neutral-container": "#e6e8ec",
    "badge-ink": "#2b2e34",
    ...BRAND_LIGHT, "br-ink": "#000000", "br-flame-ink": "#000000",
  },
  darkHc: {
    ground: "#000000", surface: "#000000", card: "#141518",
    "surface-container-lowest": "#000000", "surface-container-low": "#0c0d0f", "surface-container": "#141518",
    "surface-container-high": "#1c1d21", "surface-container-highest": "#24262a",
    "on-surface": "#ffffff", "on-surface-variant": "#e2e4e8", outline: "#ececee", "outline-variant": "#ececee",
    done: "#8eeab1", due: "#ffc978", late: "#ffb0a6", info: "#bfc5ff", "on-late": "#3d0602",
    "done-container": "#12301f", "due-container": "#3a2510", "late-container": "#3d1512", "info-container": "#1e2250", "neutral-container": "#282a2d",
    "badge-ink": "#e2e4e8",
    ...BRAND_DARK, "br-ink": "#ffffff", "br-flame-ink": "#ffffff",
  },
} as const satisfies Record<Mode, Record<string, string>>;

export type Token = keyof (typeof PALETTE)["light"];

/** Every surface a text or a control can sit on, the page's ground included. */
export const SURFACES = ["ground", "surface", "card", "surface-container-lowest", "surface-container-low", "surface-container",
  "surface-container-high", "surface-container-highest"] as const satisfies readonly Token[];

export const STATUS_TONES = ["done", "due", "late", "info"] as const;

/** Every text color the system sets on every ground it sets it on. Text floors: 4.5:1, or 7:1 in high contrast. */
export const TEXT_PAIRS: readonly [fg: Token, bg: Token][] = [
  ...(["on-surface", "on-surface-variant", ...STATUS_TONES] as const).flatMap((fg) => SURFACES.map((bg) => [fg, bg] as [Token, Token])),
  // a status label, a notice, a list row's leading circle: the tone on its own container, and the body text there
  ...STATUS_TONES.flatMap((t) => [[t, `${t}-container`], ["on-surface", `${t}-container`]] as [Token, Token][]),
  ["on-surface-variant", "neutral-container"], ["on-surface", "neutral-container"],
  // a filled danger button
  ["on-late", "late"],
  // the footer's "Powered by Boosters Rocket" badge sits on the page's ground (and a card, under the sign-in form)
  ["badge-ink", "ground"], ["badge-ink", "surface"], ["badge-ink", "card"],
  // the sign-in page's full-color badge: the product's name in its own colors (high contrast: in ink)
  ["br-ink", "ground"], ["br-flame-ink", "ground"], ["br-ink", "card"], ["br-flame-ink", "card"],
];

/** Marks that are not text but must be seen: a text field's edge, a tick box, a drawn status mark. 3:1. */
export const MARK_PAIRS: readonly [fg: Token, bg: Token][] = SURFACES.map((bg) => ["outline", bg] as [Token, Token]);

/** The browser's theme color: the top bar's surface, in light and in dark. */
export const THEME_COLOR = { light: PALETTE.light.surface, dark: PALETTE.dark.surface } as const;
