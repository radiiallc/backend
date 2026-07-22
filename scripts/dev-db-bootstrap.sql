-- backend/scripts/dev-db-bootstrap.sql
-- One-time bootstrap of the ISOLATED LOCAL dev database (WORKPLAN §1.4 "Step 0").
-- Run ONCE as the `postgres` superuser against a LOCAL Postgres. Creates a
-- dedicated least-privilege login role + an empty database it owns. Prisma then
-- builds the schema via `npm run migrate:dev` (never touching prod).
--
--   psql -U postgres -h 127.0.0.1 -f scripts/dev-db-bootstrap.sql
--
-- CREATEDB lets Prisma create/drop its own shadow database during `migrate dev`.
-- The password here is a throwaway LOCAL-ONLY dev password; it must match .env.dev.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radiia') THEN
    CREATE ROLE radiia WITH LOGIN CREATEDB PASSWORD 'radiia_local_dev';
  END IF;
END
$$;

-- CREATE DATABASE cannot run inside the DO block / a transaction, so it is a
-- plain statement. Re-running after the DB exists is a harmless error.
CREATE DATABASE radiia_dev OWNER radiia;
