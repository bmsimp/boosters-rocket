# Boosters Rocket logo exports

Every file is rendered from the vector source at its final size (nothing upscaled), and all text is converted to outlines, so no fonts are needed.

| Folder | Format | Use it for |
|---|---|---|
| `svg/` | Outlined SVG | Website, README, GitHub, Canva, Figma. Scales to any size. |
| `png/` | Transparent PNG | Email, documents, slides. |
| `pdf/` | Vector PDF | Printers, Word/Docs, Illustrator, Affinity. |
| `eps/` | Vector EPS | Screen printers, embroidery, sign shops. |
| `icons/` | PNG / ICO / SVG | App, favicon and home-screen icons. |
| `social/` | PNG + SVG | Social previews, banners, avatars, email header, video background. |
| `print/` | High-res PNG | 4096 px marks and 3600 px-wide lockups (12 in wide at 300 dpi). Prefer PDF/EPS when the printer accepts them. |

## Lockups (rocket + word)

- `lockup-horizontal-color`, `lockup-horizontal-color-dark-bg`, `lockup-horizontal-mono-{indigo|black|white}`
- `lockup-stacked-color`, `lockup-stacked-color-dark-bg`, `lockup-stacked-mono-{indigo|black|white}`
- PNG: `@1x` / `@2x` / `@4x`. Horizontal @1x = 64 px tall; stacked @1x = 88 px tall.

## Rocket mark alone

- Color: `mark-color` (dark backgrounds: `mark-color-dark-bg`)
- White / one-color: `mark-mono-open-white`, `mark-mono-badge-white`, plus `-indigo` and `-black`
- Small (16–32 px): any `-small` file. PNG at 16, 24, 32, 48. Regular marks: 64, 128, 256, 512, 1024.

## Icons (`icons/`)

| File | Size | Use |
|---|---|---|
| `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-64.png`, `favicon.ico` | 16–64 | Browser tab |
| `favicon.svg` | vector | Modern browsers |
| `apple-touch-icon-180.png` | 180 | iPhone home screen |
| `apple-touch-icon-120/152/167.png` | 120/152/167 | Older iPhone, iPad, iPad Pro |
| `icon-192.png`, `icon-384.png`, `icon-512.png` | 192/384/512 | Web app manifest |
| `icon-maskable-192.png`, `icon-maskable-512.png` | 192/512 | Android home screen (`"purpose": "maskable"`); mark sits inside the safe zone |
| `mstile-150.png` | 150 | Windows Start tile |
| `safari-pinned-tab.svg` | vector | Safari pinned tab |
| `app-store-1024-opaque.png` | 1024 | App stores / anywhere that rejects transparency (square; the store rounds the corners) |

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#1E1B4B">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:image" content="https://boostersrocket.com/og-image-1200x630.png">
<meta name="twitter:card" content="summary_large_image">
```

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-384.png", "sizes": "384x384", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

## Powered by

`powered-by-color-light`, `powered-by-color-dark`, `powered-by-mono-{indigo|black|white}`. PNG @1x = 20 px tall, plus @2x and @4x.

## Social and web (`social/`)

| File | Size | Use |
|---|---|---|
| `github-social-preview-1280x640.png` | 1280×640 | Repo Settings → General → Social preview |
| `og-image-1200x630.png` | 1200×630 | Website link previews: Facebook, LinkedIn, Slack, iMessage, X |
| `readme-banner-dark-1280x320.png`, `readme-banner-light-1280x320.png` | 1280×320 | Top of the README |
| `email-header-1200x300.png` | 1200×300 | Newsletter/email header (displays at 600×150) |
| `x-twitter-header-1500x500.png` | 1500×500 | X profile header |
| `facebook-cover-1640x624.png` | 1640×624 | Facebook page cover |
| `linkedin-banner-1584x396.png` | 1584×396 | LinkedIn page banner |
| `avatar-400.png`, `avatar-1080.png` | square | Profile pictures (GitHub org, X, Facebook, Instagram, Discord, Slack). Safe for circle crops. |
| `virtual-background-1920x1080.png` | 1920×1080 | Zoom / Teams / Meet background |

README banner that follows GitHub's light/dark theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/exports/social/readme-banner-dark-1280x320.png">
  <img alt="Boosters Rocket" src="brand/exports/social/readme-banner-light-1280x320.png">
</picture>
```

Need another size? Scale the SVG or PDF, never a PNG.
