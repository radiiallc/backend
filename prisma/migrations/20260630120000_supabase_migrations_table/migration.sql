-- Silence the recurring Supabase dashboard/CLI log error (SQLSTATE 42P01):
--   relation "supabase_migrations.schema_migrations" does not exist
--
-- We manage schema with Prisma, so Supabase's own migration-tracking table was
-- never created. Supabase's dashboard + internal tooling probe it periodically and
-- log an error every time it is missing. Creating the empty schema + table it
-- expects silences that noise.
--
-- This is OUTSIDE the Prisma datamodel (separate `supabase_migrations` schema, not
-- `public`), so Prisma never reads or drifts on it — `migrate deploy` just applies
-- this once. Plain `IF NOT EXISTS` DDL, fully idempotent, safe inside Prisma's
-- migration transaction.

CREATE SCHEMA IF NOT EXISTS "supabase_migrations";

CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations" (
  "version"    text PRIMARY KEY,
  "statements" text[],
  "name"       text
);
