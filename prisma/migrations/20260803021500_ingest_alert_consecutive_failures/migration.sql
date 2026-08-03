-- Consecutive alert-worthy ingest runs, so the alerter can hold the first failure
-- instead of emailing on it. Skylab's API returned a single HTTP 502 at 03:23 on
-- 2026-07-31, which alerted production@radiia.co and then cleared on the next
-- 15-minute tick with no intervention — a false alarm by the time it was read.
--
-- Additive with a default: existing rows (there is exactly one, id='ingest') get 0,
-- which is the same as "no failures pending", so nothing has to be backfilled.
ALTER TABLE "IngestState" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
