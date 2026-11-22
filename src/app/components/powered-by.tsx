/**
 * The "Powered by Boosters Rocket" badge (brand/BRAND.md, co-branding): the club's name, logo and color lead, and the
 * product is credited here and nowhere louder. One ink (`--badge-ink`) in the footer of every portal page, parent and
 * staff; in full color under the sign-in form. It is not a setting: no club setting removes or changes it.
 *
 * It is the kit's outlined badge (brand/logos/powered-by-mono.svg and powered-by-color-light.svg), drawn inline and
 * static, fetching nothing: its words are paths (powered-by-paths.ts), so it loads no font, and its inks are the app's
 * tokens rather than the file's, so it follows the display mode and high contrast. It is drawn 24px tall, which puts
 * "Powered by" at about 13px, over the kit's 12px floor for those words.
 * The drawing is hidden from assistive technology; the link's name is the words it shows and where it goes, so it
 * starts with what a sighted person reads (WCAG 2.5.3).
 */
import { PB_BOOSTERS, PB_MARK_X, PB_ROCKET, PB_VIEWBOX, PB_WORDS } from "./powered-by-paths";

export const BRAND_SITE = "https://boostersrocket.com";

/** The rocket, as the kit draws it in its 64-unit box (brand/logos/mark-*.svg). */
const ROCKET = "translate(40 22) rotate(40) scale(0.55) translate(-32 -33)";
const FIN_LEFT = "M20 34 L12 44 L12 50 L20 46 Z";
const FIN_RIGHT = "M44 34 L52 44 L52 50 L44 46 Z";
const BODY = "M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z";
/** The body with its window cut out, as the one-ink badge draws it. */
const BODY_WITH_WINDOW = `${BODY} M37 26 A5 5 0 1 0 27 26 A5 5 0 1 0 37 26 Z`;

/**
 * The mark between "Powered by" and the wordmark. In one ink it is the kit's open mark (the 3-puff trail and the
 * rocket, its window cut out, no disc), 22px, over the kit's 16px floor for the open mark; in color it is the small
 * color mark, the disc behind the rocket.
 */
function Mark({ color }: { color: boolean }) {
  return (
    <svg className="pb-mark" x={PB_MARK_X} y="1" width="22" height="22" viewBox="0 0 64 64">
      {color ? (
        <>
          <circle className="pb-disc" cx="32" cy="32" r="31" />
          <circle className="pb-smoke" cx="14.5" cy="38.5" r="3.8" />
          <circle className="pb-ember" cx="21.5" cy="42" r="4" />
          <circle className="pb-flame" cx="27.5" cy="36.5" r="3" />
          <g className="pb-smoke pb-stroked" transform={ROCKET}>
            <path d={FIN_LEFT} />
            <path d={FIN_RIGHT} />
            <path d={BODY} />
          </g>
        </>
      ) : (
        <>
          <circle cx="14.5" cy="38.5" r="3.8" />
          <circle cx="21.5" cy="42" r="4" />
          <circle cx="27.5" cy="36.5" r="3" />
          <g className="pb-stroked" transform={ROCKET}>
            <path d={FIN_LEFT} />
            <path d={FIN_RIGHT} />
            <path fillRule="evenodd" d={BODY_WITH_WINDOW} />
          </g>
        </>
      )}
    </svg>
  );
}

export function PoweredBy({ variant = "mono" }: { variant?: "mono" | "color" }) {
  const color = variant === "color";
  return (
    <a className={`powered-by${color ? " powered-by-color" : ""}`} href={BRAND_SITE}>
      <svg className="pb-badge" viewBox={PB_VIEWBOX} aria-hidden="true" focusable="false">
        <path className="pb-words" d={PB_WORDS} />
        <Mark color={color} />
        <path className="pb-boosters" d={PB_BOOSTERS} />
        <path className="pb-rocket" d={PB_ROCKET} />
      </svg>
      <span className="visually-hidden">Powered by Boosters Rocket, at boostersrocket.com</span>
    </a>
  );
}
