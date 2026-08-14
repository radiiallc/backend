
import { prisma } from "@/db";

import { env } from "./env";
import { runUnifiedIngest } from "./integrations/inventory/diamond-ingest";

const MIN_INTERVAL_MINUTES = 5;
const STARTUP_DELAY_MS = 30_000;

let inFlight = false;

async function tick(trigger: "startup" | "interval"): Promise<void> {
  if (inFlight) {
    console.log(`[ingest-scheduler] skip ${trigger}: previous run still in flight`);
    return;
  }
  inFlight = true;
  try {
    const result = await runUnifiedIngest();
    console.log(
      `[ingest-scheduler] ${trigger} -> ${result.status} ` +
        `(${result.rowsUpsertedTotal} upserted, ${result.durationMs}ms)`
    );
  } catch (err) {
    console.error(`[ingest-scheduler] ${trigger} threw:`, err);
  } finally {
    inFlight = false;
  }
}

export function startIngestScheduler(): void {
  if (!env.ingestSchedulerEnabled) {
    console.log("[ingest-scheduler] disabled (set INGEST_SCHEDULER_ENABLED=true to enable)");
    return;
  }

  const minutes = Math.max(MIN_INTERVAL_MINUTES, env.ingestIntervalMinutes);
  const intervalMs = minutes * 60_000;
  console.log(`[ingest-scheduler] enabled — running every ${minutes}m`);

  setTimeout(() => void tick("startup"), STARTUP_DELAY_MS);
  setInterval(() => void tick("interval"), intervalMs);
}

async function resetPgStatStatements(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe("SELECT extensions.pg_stat_statements_reset()");
    console.log("[pg-stat-maint] pg_stat_statements reset");
  } catch (err) {
    console.warn(
      "[pg-stat-maint] reset skipped (needs pg_monitor/superuser or the extension):",
      err instanceof Error ? err.message : err
    );
  }
}

export function startPgStatStatementsMaintenance(): void {
  const hours = env.pgStatResetHours;
  if (!hours || hours <= 0) {
    console.log("[pg-stat-maint] disabled (set PG_STAT_RESET_HOURS>0 to enable)");
    return;
  }
  if (!env.databaseUrl.includes(".supabase.co")) {
    console.log("[pg-stat-maint] disabled (DATABASE_URL is not a Supabase project)");
    return;
  }
  const intervalMs = hours * 60 * 60_000;
  console.log(`[pg-stat-maint] enabled — resetting pg_stat_statements every ${hours}h`);
  setTimeout(() => void resetPgStatStatements(), STARTUP_DELAY_MS);
  setInterval(() => void resetPgStatStatements(), intervalMs);
}
