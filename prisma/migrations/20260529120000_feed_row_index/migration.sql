-- AlterTable: preserve source-file row order for default sorting
ALTER TABLE "Diamond" ADD COLUMN "feedRowIndex" INTEGER;
ALTER TABLE "Gemstone" ADD COLUMN "feedRowIndex" INTEGER;

-- CreateIndex
CREATE INDEX "Diamond_feedRowIndex_idx" ON "Diamond"("feedRowIndex");
CREATE INDEX "Gemstone_feedRowIndex_idx" ON "Gemstone"("feedRowIndex");
