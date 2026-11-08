-- Custom SQL migration file, put your code below! --
INSERT INTO "role" ("key", "name", "builtin") VALUES ('admin', 'Admin', true) ON CONFLICT ("key") DO NOTHING;
