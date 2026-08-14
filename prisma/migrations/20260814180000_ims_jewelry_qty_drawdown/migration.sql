-- Piece-level draw-down for jewelry, mirroring the parcel carat draw-down.
-- Jennifer 2026-08-14: brands stock several pieces of the same SKU and we will
-- "likely be invoicing only one at a time", so a line of 16 hoops must be able to
-- send 3 out and keep 13 in stock.
--
-- quantity stays the ORIGINAL lot size; remainingQty is the running balance.
-- Nullable so pre-existing rows read as untouched (remainingQty ?? quantity),
-- and backfilled here so every current row starts at a full balance.
ALTER TABLE "JewelryDetail" ADD COLUMN "remainingQty" INTEGER;

UPDATE "JewelryDetail" SET "remainingQty" = "quantity" WHERE "remainingQty" IS NULL;

ALTER TABLE "JewelryDetail"
  ADD CONSTRAINT "JewelryDetail_remainingQty_nonneg" CHECK ("remainingQty" IS NULL OR "remainingQty" >= 0);
