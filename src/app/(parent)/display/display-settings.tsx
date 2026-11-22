"use client";
import { useEffect, useState } from "react";
import { ChoiceGroup } from "../../components/choice-group";

type Prefs = { theme: string; contrast: string; text: string; motion: string };
declare global { interface Window { BoosterDisplay?: { get(): Prefs; set(k: keyof Prefs, v: string): void } } }

/**
 * The four display choices, saved on the device (`br-display`, src/app/display-script.ts). The parent's Display page
 * draws them under its own title; the staff account page gives them a card title of their own (`title`).
 */
export function DisplaySettings({ title }: { title?: { text: string; id: string } } = {}) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  // Device-only choices are unknowable on the server, so read them after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPrefs(window.BoosterDisplay?.get() ?? { theme: "device", contrast: "device", text: "standard", motion: "device" }); }, []);
  if (!prefs) return null;
  const set = (k: keyof Prefs) => (v: string) => { window.BoosterDisplay?.set(k, v); setPrefs({ ...prefs, [k]: v }); };
  return (
    <form className="box" aria-label={title ? undefined : "Display settings"} aria-labelledby={title?.id} onSubmit={(e) => e.preventDefault()}>
      {title && <h2 id={title.id}>{title.text}</h2>}
      <ChoiceGroup name="theme" legend="Appearance" hint="Light or dark background." value={prefs.theme} onChange={set("theme")} options={[
        { value: "device", label: "Match my device", hint: "Follows your phone or computer" },
        { value: "light", label: "Light", hint: "Dark text on white" },
        { value: "dark", label: "Dark", hint: "Light text on near-black" }]} />
      <ChoiceGroup name="contrast" legend="Contrast" hint="High contrast gives stronger text and borders, and a thicker focus ring." value={prefs.contrast} onChange={set("contrast")} options={[
        { value: "device", label: "Match my device", hint: "Uses your contrast setting" },
        { value: "standard", label: "Standard" }, { value: "more", label: "High contrast" }]} />
      <ChoiceGroup name="text" legend="Text size" hint="Your browser's own zoom works too." value={prefs.text} onChange={set("text")} options={[
        { value: "standard", label: "Standard" }, { value: "large", label: "Large", size: "1.1875rem" }, { value: "larger", label: "Larger", size: "1.3125rem" }]} />
      <ChoiceGroup name="motion" legend="Motion" hint="Turn off movement and fades." value={prefs.motion} onChange={set("motion")} cols={2} options={[
        { value: "device", label: "Match my device" }, { value: "reduce", label: "Reduce motion" }]} />
      <p className="saved-note">Saved on this device. Sign in somewhere else and you can choose again there.</p>
    </form>
  );
}
