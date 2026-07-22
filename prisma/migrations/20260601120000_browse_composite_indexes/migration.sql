-- Composite indexes backing the default buyer-browse query
-- (WHERE isAvailable [AND origin] ORDER BY feedRowIndex, sku LIMIT/OFFSET).
-- IF NOT EXISTS keeps it idempotent.
--
-- NOTE (2026-07-21): CONCURRENTLY was removed so this migration can replay in
-- Prisma's shadow database. `prisma migrate dev` wraps the shadow replay in a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block (Prisma issue #8503) — so the original CONCURRENTLY form broke the whole
-- dev workflow. On prod this migration is ALREADY recorded as applied (the
-- indexes were built out-of-band with CONCURRENTLY), so prod never re-runs this
-- file; the plain CREATE INDEX below only ever executes on fresh local/shadow
-- databases, where a momentary lock on an empty table is irrelevant. The
-- resulting index is identical to the prod one.

CREATE INDEX IF NOT EXISTS "Gemstone_isAvailable_feedRowIndex_sku_idx"
  ON "Gemstone" ("isAvailable", "feedRowIndex", "sku");

CREATE INDEX IF NOT EXISTS "Diamond_isAvailable_origin_feedRowIndex_sku_idx"
  ON "Diamond" ("isAvailable", "origin", "feedRowIndex", "sku");
