/**
 * The "Powered by Boosters Rocket" badge (brand/BRAND.md, co-branding): the club's name, logo and color lead, and the
 * product is credited here and nowhere louder. One ink (`--badge-ink`) in the footer of every portal page, parent and
 * staff; in full color under the sign-in form. It is not a setting: no club setting removes or changes it.
 *
 * The kit's badge files set the name in a display face; the app has one face (Inter, DESIGN.md), so the badge is drawn
 * as the mark (brand/logos/powered-by-mono.svg's, inline and static, fetching nothing) plus the name as live text.
 * The link's name says where it goes, and starts with the words it shows (WCAG 2.5.3).
 */
export const BRAND_SITE = "https://boostersrocket.com";

/** The small mark ("Afterburn", 3-puff trail, under 32px): the rocket and its trail. `color` adds the disc behind it. */
function Mark({ color }: { color: boolean }) {
  return (
    <svg className="pb-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {color && <circle className="pb-disc" cx="32" cy="32" r="31" />}
      <circle className={color ? "pb-smoke" : undefined} cx="14.5" cy="38.5" r="3.8" />
      <circle className={color ? "pb-ember" : undefined} cx="21.5" cy="42" r="4" />
      <circle className={color ? "pb-flame" : undefined} cx="27.5" cy="36.5" r="3" />
      <g className={color ? "pb-smoke" : undefined} transform="translate(40 22) rotate(40) scale(0.55) translate(-32 -33)">
        <path d="M20 34 L12 44 L12 50 L20 46 Z" />
        <path d="M44 34 L52 44 L52 50 L44 46 Z" />
        {color
          ? <path d="M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z" />
          : <path fillRule="evenodd" d="M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z M37 26 A5 5 0 1 0 27 26 A5 5 0 1 0 37 26 Z" />}
      </g>
    </svg>
  );
}

export function PoweredBy({ variant = "mono" }: { variant?: "mono" | "color" }) {
  const color = variant === "color";
  return (
    <a className={`powered-by${color ? " powered-by-color" : ""}`} href={BRAND_SITE}>
      Powered by <Mark color={color} />
      <span className="pb-name">{color ? <><span className="pb-boosters">Boosters</span> <span className="pb-rocket">Rocket</span></> : "Boosters Rocket"}</span>
      <span className="visually-hidden">, at boostersrocket.com</span>
    </a>
  );
}
