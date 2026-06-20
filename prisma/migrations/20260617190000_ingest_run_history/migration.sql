-- Alert-state tracking on IngestState (A7.4 — ingest failure/zero-row alerting).
ALTER TABLE "IngestState" ADD COLUMN "alertActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IngestState" ADD COLUMN "lastAlertAt" TIMESTAMP(3);

-- Structured per-run ingest history (A7.5). One row per run; pruned in code to a
-- rolling window so the table stays tiny.
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "rowsUpsertedTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsParsedTotal" INTEGER NOT NULL DEFAULT 0,
    "filesProcessed" INTEGER NOT NULL DEFAULT 0,
    "diamondsMarkedStale" INTEGER NOT NULL DEFAULT 0,
    "gemstonesMarkedStale" INTEGER NOT NULL DEFAULT 0,
    "skippedFilesCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IngestRun_createdAt_idx" ON "IngestRun" ("createdAt");
