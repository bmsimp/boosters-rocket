import type { IntegrationRowKey } from "./statuses";

/**
 * Each integration's mark, in a small tile before its name. The vendors' own marks are static files in
 * public/integrations/, as each vendor publishes them, drawn small and never recolored (brand/README.md names their
 * sources; they belong to their owners). Documenso's mark is one ink (`currentColor`, as Documenso draws it), so its
 * file is a mask filled with the page's ink, in light and dark alike. Where no official mark is kept (QuickBooks:
 * brand/README.md says why), a text tile stands in. SMTP is no vendor: a plain envelope in the page's ink. The name beside the tile says
 * what it is, so the tile is hidden from a screen reader.
 */
type Mark = { src: string } | { text: string } | { mail: true } | { ink: "documenso" };
const MARKS: Record<IntegrationRowKey, Mark> = {
  quickbooks: { text: "QB" },
  documenso: { ink: "documenso" },
  "mail-graph": { src: "/integrations/microsoft.svg" },
  "mail-smtp": { mail: true },
  "staff-microsoft": { src: "/integrations/microsoft.svg" },
  "staff-google": { src: "/integrations/google.svg" },
};

export function IntegrationLogo({ of, size = "row" }: { of: IntegrationRowKey; size?: "row" | "head" }) {
  const m = MARKS[of];
  // A 20px static SVG served as it is: next/image has nothing to optimize in it.
  // eslint-disable-next-line @next/next/no-img-element
  const img = "src" in m ? <img src={m.src} alt="" width={20} height={20} /> : null;
  return (
    <span className={`logo-tile logo-${size}`} aria-hidden="true">
      {img ??
        ("ink" in m ? <span className={`logo-ink logo-${m.ink}`} />
        : "text" in m ? <span className="logo-text" data-mark={m.text} />
        : <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M3 5.5l7 5.5 7-5.5" /></svg>)}
    </span>
  );
}
