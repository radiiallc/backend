-- Third stone price tier: retail per carat, plus its app-computed total.
-- Jennifer 2026-07-30: the melee import sheet carries cost / wholesale / retail
-- per carat, and the same concept is needed for the brand jewelry held here
-- (JewelryDetail.retailPrice already exists, priced per piece rather than per ct).
--
-- Additive and nullable: every existing StoneDetail row keeps working with both
-- columns NULL, and nothing reads them until a value is entered.
ALTER TABLE "StoneDetail" ADD COLUMN "retailPricePerCt" DECIMAL(12,2);
ALTER TABLE "StoneDetail" ADD COLUMN "totalRetailPrice" DECIMAL(12,2);
