-- CreateTable
CREATE TABLE "SkuSequence" (
    "key" TEXT NOT NULL DEFAULT 'global',
    "lastValue" INTEGER NOT NULL DEFAULT 1000,

    CONSTRAINT "SkuSequence_pkey" PRIMARY KEY ("key")
);

-- Seed the counter from the current max RAD-0#### sku so newly minted skus
-- continue the existing sequence instead of colliding with it.
INSERT INTO "SkuSequence" ("key", "lastValue")
VALUES (
    'global',
    COALESCE(
        (SELECT MAX((substring(sku from '^RAD-0([0-9]+)$'))::int)
         FROM "InventoryItem"
         WHERE sku ~ '^RAD-0[0-9]+$'),
        1000
    )
);
