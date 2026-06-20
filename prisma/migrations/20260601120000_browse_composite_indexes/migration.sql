-- Composite indexes backing the default buyer-browse query
-- (WHERE isAvailable [AND origin] ORDER BY feedRowIndex, sku LIMIT/OFFSET).
-- CONCURRENTLY so the build does not lock writes on the live, resource-
-- constrained Supabase project; IF NOT EXISTS keeps it idempotent.
-- NOTE: CONCURRENTLY cannot run inside a transaction block. Apply each
-- statement on its own (the manual PrismaClient $executeRawUnsafe workaround
-- does this; `prisma migrate` wraps migrations in a tx and will reject it).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Gemstone_isAvailable_feedRowIndex_sku_idx"
  ON "Gemstone" ("isAvailable", "feedRowIndex", "sku");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Diamond_isAvailable_origin_feedRowIndex_sku_idx"
  ON "Diamond" ("isAvailable", "origin", "feedRowIndex", "sku");
