/**
 * Boosters Rocket's own icon (brand/logos/app-icon-small.svg), drawn inline and static on the setup pages: before
 * setup there is no club yet, so the product itself is what is shown. Everywhere after, the club leads and the
 * product is only the "Powered by" badge (src/app/components/powered-by.tsx). Its colors are the brand tokens.
 */
export function ProductMark() {
  return (
    <svg className="product-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect className="pm-tile" width="64" height="64" rx="14" />
      <circle className="pm-smoke" cx="14.5" cy="38.5" r="3.8" />
      <circle className="pm-ember" cx="21.5" cy="42" r="4" />
      <circle className="pm-flame" cx="27.5" cy="36.5" r="3" />
      <g transform="translate(40 22) rotate(40) scale(0.55) translate(-32 -33)">
        <path className="pm-smoke" d="M20 34 L12 44 L12 50 L20 46 Z" />
        <path className="pm-smoke" d="M44 34 L52 44 L52 50 L44 46 Z" />
        <path className="pm-smoke" d="M32 6 C40 14 44 24 44 36 L44 46 L20 46 L20 36 C20 24 24 14 32 6 Z" />
        <circle className="pm-tile" cx="32" cy="26" r="5" />
      </g>
    </svg>
  );
}
