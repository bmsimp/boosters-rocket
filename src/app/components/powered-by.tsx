/**
 * The "Powered by Boosters Rocket" badge (brand/BRAND.md, co-branding): the club's name, logo and color lead, and the
 * product is credited here and nowhere louder. One ink (`--badge-ink`) in the footer of every portal page, parent and
 * staff; in full color under the sign-in form. It is not a setting: no club setting removes or changes it.
 *
 * The kit's badge files set the name in a display face; the app has one face (Inter, DESIGN.md), so the badge is drawn
 * as the kit's small mark (inline and static, fetching nothing) plus the name as live text.
 * The link's name says where it goes, and starts with the words it shows (WCAG 2.5.3).
 */
export const BRAND_SITE = "https://boostersrocket.com";

/** The rocket and its 3-puff trail, as the kit's small marks draw them (brand/logos/mark-*-small.svg). */
const ROCKET = "translate(40 22) rotate(40) scale(0.55) translate(-32 -33)";
const BODY = "M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z";
const BADGE = "M1 32 a31 31 0 1 0 62 0 a31 31 0 1 0 -62 0Z M10.7 38.5 a3.8 3.8 0 1 0 7.6 0 a3.8 3.8 0 1 0 -7.6 0Z M17.5 42 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0Z "
  + "M24.5 36.5 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0Z M34.59 18.18 L27.68 19.56 L25.56 22.09 L30.35 23.23Z M44.7 26.66 L44.54 33.71 L42.42 36.23 L40.46 31.72Z "
  + "M49.55 10.62 C50.09 16.82 48.24 22.45 44.0 27.51 L40.46 31.72 L30.35 23.23 L33.88 19.02 C38.13 13.97 43.35 11.17 49.55 10.62 Z "
  + "M39.72 19.05 a2.75 2.75 0 1 0 5.5 0 a2.75 2.75 0 1 0 -5.5 0Z";

/**
 * The mark beside the name. In one ink it is the kit's small badge (brand/logos/mark-mono-badge-small.svg: a disc with
 * the rocket and trail knocked out), drawn at 24px, over the kit's 20px floor for the badge: the open mark's thin
 * strokes broke up at footer size. In color it is the small color mark, the disc behind the rocket.
 */
function Mark({ color }: { color: boolean }) {
  if (!color) {
    // The badge as one even-odd path, the rocket's transform worked out into its points: the disc, then each knockout
    // (the trail, the fins, the body), and the window inside the body drawn again in the ink. No mask, so no id.
    return (
      <svg className="pb-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <path fillRule="evenodd" d={BADGE} />
      </svg>
    );
  }
  return (
    <svg className="pb-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle className="pb-disc" cx="32" cy="32" r="31" />
      <circle className="pb-smoke" cx="14.5" cy="38.5" r="3.8" />
      <circle className="pb-ember" cx="21.5" cy="42" r="4" />
      <circle className="pb-flame" cx="27.5" cy="36.5" r="3" />
      <g className="pb-smoke" transform={ROCKET}>
        <path d="M20 34 L12 44 L12 50 L20 46 Z" />
        <path d="M44 34 L52 44 L52 50 L44 46 Z" />
        <path d={BODY} />
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
