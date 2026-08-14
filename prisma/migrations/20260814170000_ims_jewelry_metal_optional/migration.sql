-- Metal is no longer required on a jewelry piece.
-- Jennifer 2026-08-14: a designer's assorted "drops" lines arrive with the alloy
-- still unknown, and blocking the whole upload over three blank cells is worse
-- than holding the piece with an empty metal until she learns it.
ALTER TABLE "JewelryDetail" ALTER COLUMN "metal" DROP NOT NULL;
