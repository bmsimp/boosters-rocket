"use client";
import { useState, type CSSProperties } from "react";
import { normalizeHex } from "@/lib/theme/contrast";
import { MODES, type Mode } from "@/lib/theme/palette";
import { CLUB_ROLES, clubScheme } from "@/lib/theme/scheme";

/** The seeds a person can try at once: the default and the ones the contrast matrix checks. Sample colors, no club's. */
const PRESETS = [
  { hex: "#1e1b4b", name: "Launch Indigo (the default)" },
  { hex: "#2e7d32", name: "Green" },
  { hex: "#6a1b9a", name: "Purple" },
  { hex: "#fff59d", name: "Very light yellow" },
  { hex: "#111111", name: "Near-black" },
  { hex: "#d50000", name: "Red" },
] as const;

const MODE_LABEL: Record<Mode, { label: string; theme: "light" | "dark"; contrast?: "more" }> = {
  light: { label: "Light", theme: "light" },
  dark: { label: "Dark", theme: "dark" },
  lightHc: { label: "Light, high contrast", theme: "light", contrast: "more" },
  darkHc: { label: "Dark, high contrast", theme: "dark", contrast: "more" },
};

/**
 * The seed picker: a club color, and the M3 scheme clubScheme() makes from it in every display mode, each role's value
 * and a small sample drawn in it (a filled and a tonal button, the current tab's pill, a tonal card). The roles are set
 * on each sample's wrapper, over the page's own. A sample: nothing is saved.
 */
export function SeedSample() {
  const [seed, setSeed] = useState<string>(PRESETS[0].hex);
  const hex = normalizeHex(seed) ?? PRESETS[0].hex;
  const scheme = clubScheme(hex);
  return (
    <div className="ds-seed">
      <div className="toolbar">
        <div className="field"><label className="field-label" htmlFor="ds-seed-color">Club color</label>
          <input id="ds-seed-color" type="color" value={hex} onChange={(e) => setSeed(e.target.value)} /></div>
        <fieldset className="connected">
          <legend>Try a color</legend>
          <div className="connected-options">
            {PRESETS.map((p) => (
              <label className="connected-option" key={p.hex}>
                <input type="radio" name="ds-seed-preset" value={p.hex} checked={hex === p.hex} onChange={() => setSeed(p.hex)} />
                <span className="ds-seed-dot" style={{ ["--swatch" as string]: p.hex } as CSSProperties} aria-hidden="true" />{p.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <p className="ds-note">The logo tile keeps the exact color, {scheme.seed}, with {scheme.onSeed} on it. Everything else is the scheme below.</p>
      <div className="ds-pair">
        {MODES.map((mode) => {
          const roles = scheme.modes[mode];
          const style = Object.fromEntries([...Object.entries(roles).map(([k, v]) => [`--${k}`, v]), ["--seed", scheme.seed], ["--on-seed", scheme.onSeed]]) as CSSProperties;
          const m = MODE_LABEL[mode];
          return (
            <div key={mode} className="theme-sample ds-scheme" data-theme={m.theme} data-contrast={m.contrast} style={style}>
              <p className="section-label">{m.label}</p>
              <div className="ds-scheme-sample">
                <span className="monogram" aria-hidden="true">SB</span>
                <span className="btn">Pay</span>
                <span className="btn btn-tonal">Sign</span>
                <span className="ds-pill" aria-hidden="true">Home</span>
              </div>
              <div className="box box-tonal"><p><b>1 new message</b> from the club, on its primary container.</p></div>
              <div className="ds-roles">
                {[...CLUB_ROLES, "focus" as const].map((r) => (
                  <span key={r} className="ds-swatch" style={{ ["--swatch" as string]: roles[r] } as CSSProperties}><b>--{r}</b>{roles[r]}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
