// In-process ingest scheduler.
//
// Why this exists: the ingest used to be driven by a GitHub Actions `schedule:`
// cron (backend/.github/workflows/ingest.yml). GitHub's scheduler proved
// catastrophically unreliable for this repo — with a "*/30" cron it was firing
// only every 2-3 hours (dropping ~80% of runs), so the feed silently went stale
// and buyers got requests for already-sold stones.
//
// This server runs always-on on Railway (that's why the stack moved off Vercel),
// so a plain in-process interval is a far more reliable clock than GitHub's
// best-effort scheduler. The ingest is an idempotent upsert, so over-running is
// harmless; an in-flight guard stops a slow run from overlapping the next tick,
// and every run is wrapped so a throw can never crash the API server.

import { env } from "./env";
import { runUnifiedIngest } from "./integrations/inventory/diamond-ingest";

// Floor the interval so a typo (e.g. INGEST_INTERVAL_MINUTES=0) can't hammer the
// vendor FTP feed. 5 min is well below the ~30-min freshness target.
const MIN_INTERVAL_MINUTES = 5;
// Delay the first run so boot/migrations settle and startup isn't blocked.
const STARTUP_DELAY_MS = 30_000;

let inFlight = false;

async function tick(trigger: "startup" | "interval"): Promise<void> {
  if (inFlight) {
    // eslint-disable-next-line no-console
    console.log(`[ingest-scheduler] skip ${trigger}: previous run still in flight`);
    return;
  }
  inFlight = true;
  try {
    const result = await runUnifiedIngest();
    // eslint-disable-next-line no-console
    console.log(
      `[ingest-scheduler] ${trigger} -> ${result.status} ` +
        `(${result.rowsUpsertedTotal} upserted, ${result.durationMs}ms)`
    );
  } catch (err) {
    // runUnifiedIngest normally returns {status:"error"} rather than throwing,
    // but guard anyway — the scheduler must never take the server down.
    // eslint-disable-next-line no-console
    console.error(`[ingest-scheduler] ${trigger} threw:`, err);
  } finally {
    inFlight = false;
  }
}

export function startIngestScheduler(): void {
  if (!env.ingestSchedulerEnabled) {
    // eslint-disable-next-line no-console
    console.log("[ingest-scheduler] disabled (set INGEST_SCHEDULER_ENABLED=true to enable)");
    return;
  }

  const minutes = Math.max(MIN_INTERVAL_MINUTES, env.ingestIntervalMinutes);
  const intervalMs = minutes * 60_000;
  // eslint-disable-next-line no-console
  console.log(`[ingest-scheduler] enabled — running every ${minutes}m`);

  setTimeout(() => void tick("startup"), STARTUP_DELAY_MS);
  // Node timers are not GC'd while active; no need to retain the handle.
  setInterval(() => void tick("interval"), intervalMs);
}
