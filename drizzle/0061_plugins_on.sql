-- Custom SQL migration file, put your code below! --
-- Stage 5's slice P1 (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 6): every installation
-- that finished setup is a QuickBooks club, so QuickBooks is on there. A new installation, or one still in setup,
-- starts with nothing stored, which is no plugin on; finishing setup turns QuickBooks on until setup asks (slice P8).
-- A value already stored is kept.
INSERT INTO "setting" ("key", "value")
SELECT 'plugins.on', '["quickbooks"]'::jsonb
WHERE EXISTS (SELECT 1 FROM "setting" WHERE "key" = 'setup.state' AND "value"->>'status' = 'finished')
ON CONFLICT ("key") DO NOTHING;
