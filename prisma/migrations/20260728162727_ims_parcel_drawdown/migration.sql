-- PARCEL draw-down (Jennifer 2026-07-28 melee pilot). A parcel is sold in carat
-- slices, not all at once: a 16.76 ct lot of 1.2mm rubies gets invoiced ~0.40 ct
-- at a time. weightCt/quantity keep meaning the ORIGINAL lot size (they are the
-- purchase record); these two new columns carry the running balance.
--
-- Additive and nullable, so append-only and safe on prod. SINGLE/PAIR rows stay
-- NULL and keep their existing atomic behaviour — nothing about non-parcel stones
-- changes.

-- AlterTable
ALTER TABLE "StoneDetail" ADD COLUMN     "remainingCt" DECIMAL(10,3),
ADD COLUMN     "remainingQty" INTEGER;

-- Backfill existing parcels: a parcel that has never been drawn is, by
-- definition, entirely remaining. Scoped to itemSubtype = 'PARCEL' so single
-- stones and pairs stay NULL (= "not a draw-down item").
UPDATE "StoneDetail" sd
SET "remainingCt"  = sd."weightCt",
    "remainingQty" = sd."quantity"
FROM "InventoryItem" ii
WHERE ii."id" = sd."inventoryItemId"
  AND ii."itemSubtype" = 'PARCEL';

-- Floor the balances at zero in the database itself. The service validates
-- 0 < draw <= remaining before writing, but a parcel going negative would mean
-- selling stock that does not exist — worth a constraint rather than trusting a
-- single code path forever.
ALTER TABLE "StoneDetail" ADD CONSTRAINT "StoneDetail_remainingCt_nonneg" CHECK ("remainingCt" IS NULL OR "remainingCt" >= 0);
ALTER TABLE "StoneDetail" ADD CONSTRAINT "StoneDetail_remainingQty_nonneg" CHECK ("remainingQty" IS NULL OR "remainingQty" >= 0);
