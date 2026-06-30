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

import { prisma } from "@/db";

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

// --- pg_stat_statements maintenance ----------------------------------------
// Supabase runs an internal scraper that aggregates extensions.pg_stat_statements
// every few minutes. That view stores the full text of every distinct statement,
// so if it accumulates many large query strings the scrape walks hundreds of MB,
// exceeds the statement timeout (SQLSTATE 57014) and drives the daily CPU climb we
// saw. The fixed-shape ingest upserts keep it from bloating, and this periodic
// reset both clears any pre-existing bloat and caps growth from any other source —
// so the operator never has to run pg_stat_statements_reset() by hand again.
//
// Defensive by design: the reset needs pg_monitor/superuser, so if the app's DB
// role lacks the grant (or the extension isn't installed) we log once and move on
// rather than crash or spam.
async function resetPgStatStatements(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe("SELECT extensions.pg_stat_statements_reset()");
    // eslint-disable-next-line no-console
    console.log("[pg-stat-maint] pg_stat_statements reset");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pg-stat-maint] reset skipped (needs pg_monitor/superuser or the extension):",
      err instanceof Error ? err.message : err
    );
  }
}

export function startPgStatStatementsMaintenance(): void {
  const hours = env.pgStatResetHours;
  if (!hours || hours <= 0) {
    // eslint-disable-next-line no-console
    console.log("[pg-stat-maint] disabled (set PG_STAT_RESET_HOURS>0 to enable)");
    return;
  }
  const intervalMs = hours * 60 * 60_000;
  // eslint-disable-next-line no-console
  console.log(`[pg-stat-maint] enabled — resetting pg_stat_statements every ${hours}h`);
  // Clear pre-existing bloat shortly after boot, then on the interval.
  setTimeout(() => void resetPgStatStatements(), STARTUP_DELAY_MS);
  setInterval(() => void resetPgStatStatements(), intervalMs);
}
