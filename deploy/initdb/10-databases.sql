-- Run by Postgres on its first start only, on an empty data volume (deploy/compose.yml mounts this folder at
-- /docker-entrypoint-initdb.d). Makes the portal's database and Documenso's, each owned by a role of its own with its
-- own password, read from the environment (PORTAL_DB_PASSWORD, DOCUMENSO_DB_PASSWORD) so it is written nowhere else.
-- Neither role can open the other's database. Documenso makes the extensions it needs (pgcrypto, pg_trgm) itself, as
-- the owner of its database. A password changed in deploy/.env later is not changed here: docs/runbooks/first-install.md
-- says how.
\set ON_ERROR_STOP on
\getenv portal_password PORTAL_DB_PASSWORD
\getenv documenso_password DOCUMENSO_DB_PASSWORD

create role booster login password :'portal_password';
create database booster owner booster;
revoke all on database booster from public;

create role documenso login password :'documenso_password';
create database documenso owner documenso;
revoke all on database documenso from public;
