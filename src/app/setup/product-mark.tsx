/**
 * Boosters Rocket's own icon (brand/logos/app-icon.svg, the kit's rounded-square icon with its full trail, for 32px
 * and over: it is drawn at 40px), inline and static on the setup pages: before setup there is no club yet, so the
 * product itself is what is shown. Everywhere after, the club leads and the product is only the "Powered by" badge
 * (src/app/components/powered-by.tsx). Its colors are the brand tokens (`--br-*`), not the file's.
 */
const PUFFS: readonly [cx: number, cy: number, r: number, tone: "smoke" | "glow" | "ember" | "flame"][] = [
  [10.4, 33.4, 1.8, "smoke"], [12.4, 36.4, 2.7, "smoke"], [13.6, 41.8, 1.6, "smoke"], [15.6, 40, 3.2, "smoke"],
  [17.4, 45.4, 1.8, "glow"], [19.2, 43.2, 3.4, "glow"],
  [24.2, 43.6, 1.8, "ember"], [22.6, 41.4, 3.3, "ember"],
  [27.6, 39.4, 1.6, "flame"], [26, 38.2, 2.8, "flame"], [28.8, 35, 2.2, "flame"],
];

export function ProductMark() {
  return (
    <svg className="product-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect className="pm-tile" width="64" height="64" rx="14" />
      {PUFFS.map(([cx, cy, r, tone]) => <circle key={`${cx},${cy}`} className={`pm-${tone}`} cx={cx} cy={cy} r={r} />)}
      <g transform="translate(40 22) rotate(40) scale(0.55) translate(-32 -33)">
        <g className="pm-rocket">
          <path d="M20 34 L12 44 L12 50 L20 46 Z" />
          <path d="M44 34 L52 44 L52 50 L44 46 Z" />
          <path d="M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z" />
        </g>
        <circle className="pm-tile" cx="32" cy="26" r="5" />
      </g>
    </svg>
  );
}
