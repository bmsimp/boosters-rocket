# UI, in depth

What this covers: the closing blocks of `booster.css` and the installed app, beside the UI rules in `AGENTS.md`. The rules of `AGENTS.md` still apply.

## UI

- `src/app/booster.css` ends with eight marked blocks: Home and Family, then Season (the ruler's heading, requirement lines, the staff season pages), then Volunteer, then Forms (the signing frame), then Staff pages (the staff primitives: tables, notices, form controls, the staff home, Parents), then Settings and the staff menu (the grouped menu, the settings view, roles, the Staff page), then Accessibility fixes for parent pages, then the installed app (safe areas, the install hint), which must stay last.
- Installed app: the manifest (`src/app/manifest.ts`) and the icons are built on each request from the club's settings and hold no hostname. Icon names are `ICONS` in `src/lib/pwa/icons.ts`. `InstallHint` and `RefreshOnResume` (`src/app/components/pwa/`) are given no club or family data.
