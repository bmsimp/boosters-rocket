/**
 * Writes design/system/gallery.html: the design-system gallery (src/app/staff/(app)/settings/design-system/gallery.tsx) as one
 * self-contained page, the stylesheet inlined and the default club color set, so the system can be opened and
 * screenshotted without the app or a database. It fetches nothing: no font (Inter comes through next/font in the app,
 * so the twin shows the fallback face), no script, no image. Run it again after changing a primitive or booster.css:
 *
 *   pnpm tsx scripts/design-gallery.tsx
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "sass";
import { sheets } from "./design-gallery-sheets";
import { Gallery } from "../src/app/staff/(app)/settings/design-system/gallery";
import { PoweredBy } from "../src/app/components/powered-by";
import { clubCssVars, clubScheme } from "../src/lib/theme/scheme";

/** DEFAULT_COLOR in src/lib/settings/club.ts, which is not imported: that module opens the database. */
const DEFAULT_COLOR = "#1e1b4b";

const css = [readFileSync("src/app/booster.css", "utf8"), ...sheets.map((f) => compile(f, { style: "expanded", quietDeps: true }).css)].join("\n");
const vars = Object.entries(clubCssVars(clubScheme(DEFAULT_COLOR))).map(([k, v]) => `${k}: ${v}`).join("; ");
const body = renderToStaticMarkup(
  <>
    <header className="bar">
      <div className="wrap">
        <span className="monogram" aria-hidden="true">SB</span>
        <span className="club">Sample Boosters</span>
        <span className="account" aria-hidden="true">AS</span>
      </div>
    </header>
    <main className="wrap single ds-page"><Gallery /></main>
    <footer className="wrap"><PoweredBy /></footer>
  </>,
);

const html = `<!doctype html>
<!-- Made by scripts/design-gallery.tsx from the gallery's own components and src/app/booster.css. Do not edit by hand. -->
<html lang="en" style="${vars}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Design system · Boosters Rocket</title>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
mkdirSync("design/system", { recursive: true });
writeFileSync("design/system/gallery.html", html);
console.log(`design/system/gallery.html: ${Math.round(html.length / 1024)} KB`);
