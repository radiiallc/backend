-- CreateTable
CREATE TABLE "IngestState" (
    "id" TEXT NOT NULL,
    "lastFeedMtime" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunStats" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestState_pkey" PRIMARY KEY ("id")
);
