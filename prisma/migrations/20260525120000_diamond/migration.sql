-- CreateTable
CREATE TABLE "Diamond" (
    "id" TEXT NOT NULL,
    "feedRowId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "shapeRaw" TEXT,
    "shapeMapped" TEXT,
    "weightCt" DECIMAL(10,3),
    "colorWhite" TEXT,
    "fancyColor" TEXT,
    "fancyIntensity" TEXT,
    "fancyOvertone" TEXT,
    "clarity" TEXT,
    "cutGrade" TEXT,
    "polish" TEXT,
    "symmetry" TEXT,
    "fluorescence" TEXT,
    "lengthMm" DECIMAL(10,3),
    "widthMm" DECIMAL(10,3),
    "depthMm" DECIMAL(10,3),
    "ratio" DECIMAL(10,4),
    "depthPct" DECIMAL(6,2),
    "tablePct" DECIMAL(6,2),
    "girdle" TEXT,
    "culet" TEXT,
    "certLab" TEXT,
    "certNumber" TEXT,
    "certUrl" TEXT,
    "treatment" TEXT,
    "growthMethod" TEXT,
    "basePricePerCtUsd" DECIMAL(12,2),
    "basePriceUsd" DECIMAL(12,2),
    "state" TEXT,
    "country" TEXT,
    "photoUrl" TEXT,
    "videoUrl" TEXT,
    "rawFeedRow" JSONB NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Diamond_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Diamond_feedRowId_key" ON "Diamond"("feedRowId");

-- CreateIndex
CREATE INDEX "Diamond_sku_idx" ON "Diamond"("sku");

-- CreateIndex
CREATE INDEX "Diamond_vendor_idx" ON "Diamond"("vendor");

-- CreateIndex
CREATE INDEX "Diamond_origin_idx" ON "Diamond"("origin");

-- CreateIndex
CREATE INDEX "Diamond_isAvailable_idx" ON "Diamond"("isAvailable");

-- CreateIndex
CREATE INDEX "Diamond_weightCt_idx" ON "Diamond"("weightCt");
