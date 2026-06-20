-- AlterTable: numeric clarity rank for server-side graded sorting (FL highest → I3 lowest).
-- NULL for unknown/empty grades and for rows ingested before this migration, until the
-- next ingest backfills them. Sorted NULLS LAST so unranked rows fall to the bottom.
ALTER TABLE "Diamond" ADD COLUMN "clarityRank" INTEGER;

-- Backfill existing rows from the current `clarity` value so clarity sorting works
-- immediately without waiting for a re-ingest.
UPDATE "Diamond" SET "clarityRank" = CASE upper(trim("clarity"))
  WHEN 'FL'   THEN 11
  WHEN 'IF'   THEN 10
  WHEN 'VVS1' THEN 9
  WHEN 'VVS2' THEN 8
  WHEN 'VS1'  THEN 7
  WHEN 'VS2'  THEN 6
  WHEN 'SI1'  THEN 5
  WHEN 'SI2'  THEN 4
  WHEN 'I1'   THEN 3
  WHEN 'I2'   THEN 2
  WHEN 'I3'   THEN 1
  ELSE NULL
END
WHERE "clarity" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Diamond_clarityRank_idx" ON "Diamond"("clarityRank");
