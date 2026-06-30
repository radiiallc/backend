import { Prisma, prisma } from "@/db";
import { clarityRank, isExcludedShape, mapDiamondShape, mapGemstoneShape } from "@/domain";

import { env } from "../../env";
import { sendIngestFailureAlert, sendIngestRecoveryAlert } from "../email";

import { downloadIngestFile, listIngestFiles } from "./ftp-dir";
import {
  detectFileTarget,
  feedIdentityForTarget,
  parseRapNetCsv,
  type ParsedDiamond,
  type ParsedGemstone
} from "./rapnet-parser";

const BULK_CHUNK = 800;

const PARALLEL_CHUNKS_PER_FILE = 4;

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Transient write-retry --------------------------------------------------
// A write can fail mid-run if Postgres is momentarily read-only — e.g. a disk
// pressure / autoscale-resize event or a failover flips the primary to read-only
// (SQLSTATE 25006), or the server is briefly not accepting connections
// (57P03 / 57P01). These windows are usually seconds long. The scheduler already
// retries the whole run on the next tick, but riding out a short blip *inside* a
// run avoids a failed run + alert email for a hiccup that clears on its own.
//
// This is a backstop for SHORT outages only: total backoff caps at ~15s, so a
// genuine multi-hour read-only event (e.g. a full disk — the 2026-06-25 incident)
// still fails the run by design. That failure is what surfaces the real problem,
// so we deliberately do not try to paper over a sustained outage here.
const RETRYABLE_PG_CODES = new Set([
  "25006", // read_only_sql_transaction
  "57P03", // cannot_connect_now (server starting / not accepting connections)
  "57P01" // admin_shutdown (connection terminated, e.g. failover)
]);
const WRITE_RETRY_MAX_ATTEMPTS = 6; // 1 initial try + 5 retries
const WRITE_RETRY_BASE_MS = 500;
const WRITE_RETRY_CAP_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the matched SQLSTATE if the error is a transient, retryable write
// failure, else null. Prisma surfaces raw-query failures as a known-request error
// (code P2010) with the Postgres SQLSTATE in `meta.code`; the code/phrase is also
// embedded in the message text, so we check both.
function retryablePgCode(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const metaCode = typeof err.meta?.code === "string" ? err.meta.code : null;
    if (metaCode && RETRYABLE_PG_CODES.has(metaCode)) return metaCode;
  }
  const msg = err instanceof Error ? err.message : String(err);
  for (const code of RETRYABLE_PG_CODES) {
    if (msg.includes(code)) return code;
  }
  // Phrase fallback for the common case where the numeric code isn't in the text.
  if (/read-only transaction/i.test(msg)) return "25006";
  if (/not accepting connections/i.test(msg)) return "57P03";
  return null;
}

// Runs a DB write, retrying with exponential backoff + jitter on a transient
// read-only / unavailable error. Non-transient errors throw immediately.
async function withWriteRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = retryablePgCode(err);
      if (!code || attempt >= WRITE_RETRY_MAX_ATTEMPTS) throw err;
      const backoff = Math.min(WRITE_RETRY_CAP_MS, WRITE_RETRY_BASE_MS * 2 ** (attempt - 1));
      // Jitter avoids a thundering herd across the parallel upsert chunks.
      const delay = backoff + Math.floor(Math.random() * 250);
      console.warn(
        `[ingest] write "${label}" hit transient ${code}; ` +
          `retry ${attempt}/${WRITE_RETRY_MAX_ATTEMPTS - 1} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}

type PerFileResult = {
  name: string;
  target: string;
  rowsParsed: number;
  rowsUpserted: number;
  rejected: { reason: string; count: number }[];
  fetchMs?: number;
  parseMs?: number;
  upsertMs?: number;
};

export type IngestOutcome = {
  status: "ok" | "no-files" | "error";
  source?: "ftp" | "fallback";
  files: PerFileResult[];
  rowsUpsertedTotal: number;
  diamondsMarkedStale: number;
  gemstonesMarkedStale: number;
  skippedFiles: { name: string; reason: string }[];
  errorText?: string;
  durationMs: number;
};

export async function runDiamondIngest(): Promise<IngestOutcome> {
  return runUnifiedIngest();
}

export async function runUnifiedIngest(): Promise<IngestOutcome> {
  const startedAt = Date.now();
  const skippedFiles: { name: string; reason: string }[] = [];
  const fileResults: PerFileResult[] = [];

  try {
    const { source, files } = await listIngestFiles();

    if (files.length === 0) {
      await touchIngestState("ingest", { errorText: null, source, files: [] });
      return finalizeRun({
        status: "no-files",
        source,
        files: [],
        rowsUpsertedTotal: 0,
        diamondsMarkedStale: 0,
        gemstonesMarkedStale: 0,
        skippedFiles: [],
        durationMs: Date.now() - startedAt
      });
    }

    const seenDiamondIds = new Set<string>();
    const seenGemstoneIds = new Set<string>();
    let upsertTotal = 0;

    const perFile = await Promise.all(
      files.map(async (file) => {
        const target = detectFileTarget(file.name);
        if (!target) {
          skippedFiles.push({ name: file.name, reason: "unknown-filename-pattern" });
          return null;
        }

        const tFetch = Date.now();
        const dl = await downloadIngestFile(file.name);
        const fetchMs = Date.now() - tFetch;
        const tParse = Date.now();
        const parsed = parseRapNetCsv(dl.csvText, target);
        const parseMs = Date.now() - tParse;

        const allDiamondRows = parsed.rows.filter(
          (r): r is ParsedDiamond => r.kind === "diamond"
        );
        const allGemstoneRows = parsed.rows.filter(
          (r): r is ParsedGemstone => r.kind === "gemstone"
        );

        let excludedShapeCount = 0;
        const diamondRows = allDiamondRows.filter((r) => {
          if (isExcludedShape(r.shapeRaw)) {
            excludedShapeCount++;
            return false;
          }
          return true;
        });
        const gemstoneRows = allGemstoneRows.filter((r) => {
          if (isExcludedShape(r.shapeRaw)) {
            excludedShapeCount++;
            return false;
          }
          return true;
        });
        if (excludedShapeCount > 0) {
          parsed.rejected.push({
            reason: "excluded-shape",
            count: excludedShapeCount
          });
        }

        const tUp = Date.now();
        const dChunks: ParsedDiamond[][] = [];
        for (let i = 0; i < diamondRows.length; i += BULK_CHUNK) {
          dChunks.push(diamondRows.slice(i, i + BULK_CHUNK));
        }
        const gChunks: ParsedGemstone[][] = [];
        for (let i = 0; i < gemstoneRows.length; i += BULK_CHUNK) {
          gChunks.push(gemstoneRows.slice(i, i + BULK_CHUNK));
        }
        const dCounts = await parallelMap(dChunks, PARALLEL_CHUNKS_PER_FILE, bulkUpsertDiamonds);
        const gCounts = await parallelMap(gChunks, PARALLEL_CHUNKS_PER_FILE, bulkUpsertGemstones);
        const upsertCount =
          dCounts.reduce((a, b) => a + b, 0) + gCounts.reduce((a, b) => a + b, 0);
        const upsertMs = Date.now() - tUp;

        const targetLabel = target.kind === "diamond"
          ? `${target.vendor} (${target.origin})`
          : "Gemstone";

        // Per-feed upload signal: dl.mtime is the feed file's modify-time on the
        // FTP (i.e. when the vendor last pushed it), which is what the dashboard
        // shows so the team can spot a feed that has stopped updating.
        const feed = feedIdentityForTarget(target);

        return {
          result: {
            name: file.name,
            target: targetLabel,
            rowsParsed: parsed.rows.length,
            rowsUpserted: upsertCount,
            rejected: parsed.rejected,
            fetchMs,
            parseMs,
            upsertMs
          },
          feed: { key: feed.key, label: feed.label, mtime: dl.mtime, rowsParsed: parsed.rows.length },
          diamondRows,
          gemstoneRows,
          upsertCount
        };
      })
    );

    const feedsSeen = new Map<string, { label: string; mtime: Date; rowsParsed: number }>();
    for (const f of perFile) {
      if (!f) continue;
      fileResults.push(f.result);
      upsertTotal += f.upsertCount;
      for (const r of f.diamondRows) seenDiamondIds.add(r.feedRowId);
      for (const r of f.gemstoneRows) seenGemstoneIds.add(r.feedRowId);
      const prev = feedsSeen.get(f.feed.key);
      if (!prev) {
        feedsSeen.set(f.feed.key, { label: f.feed.label, mtime: f.feed.mtime, rowsParsed: f.feed.rowsParsed });
      } else {
        if (f.feed.mtime > prev.mtime) prev.mtime = f.feed.mtime;
        prev.rowsParsed += f.feed.rowsParsed;
      }
    }

    // Persist this run's per-feed upload timestamps. Only feeds present in this
    // run are touched, so a feed whose file stopped arriving keeps its last-seen
    // timestamp and shows as stale on the dashboard. Best-effort: bookkeeping
    // here must never fail the ingest itself.
    await recordFeedStatuses(feedsSeen);

    const diamondsStale = seenDiamondIds.size > 0
      ? { count: await markStale("Diamond", Array.from(seenDiamondIds)) }
      : { count: 0 };

    const gemstonesStale = seenGemstoneIds.size > 0
      ? { count: await markStale("Gemstone", Array.from(seenGemstoneIds)) }
      : { count: 0 };

    await touchIngestState("ingest", {
      errorText: null,
      source,
      files: fileResults,
      rowsUpsertedTotal: upsertTotal,
      diamondsMarkedStale: diamondsStale.count,
      gemstonesMarkedStale: gemstonesStale.count
    });

    return finalizeRun({
      status: "ok",
      source,
      files: fileResults,
      rowsUpsertedTotal: upsertTotal,
      diamondsMarkedStale: diamondsStale.count,
      gemstonesMarkedStale: gemstonesStale.count,
      skippedFiles,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    await touchIngestState("ingest", { errorText });
    return finalizeRun({
      status: "error",
      files: fileResults,
      rowsUpsertedTotal: 0,
      diamondsMarkedStale: 0,
      gemstonesMarkedStale: 0,
      skippedFiles,
      errorText,
      durationMs: Date.now() - startedAt
    });
  }
}

// How many recent runs to retain in the IngestRun history table (A7.5). At the
// hourly cron cadence this is ~8 days; the table stays tiny.
const RUN_HISTORY_KEEP = 200;

// Records the run in the structured history and evaluates alerting. Both steps
// are best-effort: a logging/alerting failure must never fail the ingest itself
// or change its outcome, so each is wrapped and the original outcome is returned.
async function finalizeRun(outcome: IngestOutcome): Promise<IngestOutcome> {
  const rowsParsedTotal = outcome.files.reduce((sum, f) => sum + f.rowsParsed, 0);

  try {
    await prisma.ingestRun.create({
      data: {
        status: outcome.status,
        source: outcome.source ?? null,
        rowsUpsertedTotal: outcome.rowsUpsertedTotal,
        rowsParsedTotal,
        filesProcessed: outcome.files.length,
        diamondsMarkedStale: outcome.diamondsMarkedStale,
        gemstonesMarkedStale: outcome.gemstonesMarkedStale,
        skippedFilesCount: outcome.skippedFiles.length,
        durationMs: outcome.durationMs,
        errorText: outcome.errorText ?? null
      }
    });
    await pruneRunHistory();
  } catch (err) {
    console.error("[ingest] failed to record run history", err);
  }

  try {
    await evaluateAndAlert(outcome, rowsParsedTotal);
  } catch (err) {
    console.error("[ingest] alert evaluation failed", err);
  }

  return outcome;
}

async function pruneRunHistory(): Promise<void> {
  const cutoff = await prisma.ingestRun.findMany({
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    skip: RUN_HISTORY_KEEP,
    take: 1
  });
  if (cutoff.length > 0) {
    await prisma.ingestRun.deleteMany({
      where: { createdAt: { lt: cutoff[0].createdAt } }
    });
  }
}

// Decides whether this run is alert-worthy. A run is "bad" when it errors,
// delivers no files, or parses zero rows overall (a silent feed gap). A partial
// gap — some files present but individual feed files empty — is also surfaced,
// since one broken feed among several would otherwise go unnoticed. Note: zero
// *upserts* is NOT an alert — the change-detection skip means an unchanged feed
// legitimately upserts 0 rows.
function classifyOutcome(
  outcome: IngestOutcome,
  rowsParsedTotal: number
): { isAlert: boolean; reason: string } {
  if (outcome.status === "error") {
    return { isAlert: true, reason: `Ingest run failed: ${outcome.errorText ?? "unknown error"}` };
  }
  if (outcome.status === "no-files") {
    return {
      isAlert: true,
      reason: "No feed files found: the feed delivered nothing this run."
    };
  }
  if (rowsParsedTotal === 0) {
    return {
      isAlert: true,
      reason: "Zero rows parsed: feed files were present but contained no usable rows."
    };
  }
  const emptyFiles = outcome.files.filter((f) => f.rowsParsed === 0);
  if (emptyFiles.length > 0) {
    return {
      isAlert: true,
      reason: `Empty feed file(s): ${emptyFiles.map((f) => f.name).join(", ")} parsed 0 rows.`
    };
  }
  return { isAlert: false, reason: "" };
}

async function evaluateAndAlert(outcome: IngestOutcome, rowsParsedTotal: number): Promise<void> {
  const { isAlert, reason } = classifyOutcome(outcome, rowsParsedTotal);
  const state = await prisma.ingestState.findUnique({ where: { id: "ingest" } });
  const alertActive = state?.alertActive ?? false;
  const lastAlertAt = state?.lastAlertAt ?? null;
  const throttleMs = env.ingestAlertThrottleHours * 60 * 60 * 1000;

  if (isAlert) {
    const throttleElapsed =
      !lastAlertAt || Date.now() - lastAlertAt.getTime() >= throttleMs;
    if (alertActive && !throttleElapsed) return; // already alerted recently

    await sendIngestFailureAlert({
      reason,
      status: outcome.status,
      source: outcome.source ?? null,
      durationMs: outcome.durationMs,
      rowsUpsertedTotal: outcome.rowsUpsertedTotal,
      files: outcome.files.map((f) => ({
        name: f.name,
        rowsParsed: f.rowsParsed,
        rowsUpserted: f.rowsUpserted
      })),
      skippedFiles: outcome.skippedFiles,
      errorText: outcome.errorText ?? null,
      repeated: alertActive
    });
    await setAlertState({ alertActive: true, lastAlertAt: new Date() });
    return;
  }

  if (alertActive) {
    await sendIngestRecoveryAlert({
      rowsUpsertedTotal: outcome.rowsUpsertedTotal,
      source: outcome.source ?? null
    });
    await setAlertState({ alertActive: false });
  }
}

async function setAlertState(data: { alertActive: boolean; lastAlertAt?: Date }): Promise<void> {
  await prisma.ingestState.upsert({
    where: { id: "ingest" },
    create: { id: "ingest", ...data },
    update: data
  });
}

function genCuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function dedupeByFeedRowId<T extends { feedRowId: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const r of rows) map.set(r.feedRowId, r);
  return Array.from(map.values());
}

// Columns compared (via IS DISTINCT FROM EXCLUDED) to decide whether an existing
// row actually changed. When none differ, the ON CONFLICT DO UPDATE is skipped
// for that row — no new tuple, no index churn, no WAL — so the hourly ingest no
// longer rewrites ~10k unchanged rows every run (the main Disk IO drain on a
// small Postgres instance). `isAvailable` is included so rows that went stale and
// then reappear in the feed are reactivated (EXCLUDED."isAvailable" is always TRUE).
// `lastSeenAt`/`updatedAt` are intentionally excluded — they are always NOW(), so
// comparing them would defeat the skip. Staleness is tracked from the in-memory
// seen-id set (see markStale), not from lastSeenAt, so leaving it stale is safe.
const DIAMOND_CHANGE_COLUMNS = [
  "feedRowIndex", "vendor", "origin", "sku", "shapeRaw", "shapeMapped", "weightCt",
  "colorWhite", "fancyColor", "fancyIntensity", "fancyOvertone", "clarity", "clarityRank",
  "cutGrade", "polish", "symmetry", "fluorescence", "lengthMm", "widthMm", "depthMm",
  "ratio", "depthPct", "tablePct", "girdle", "culet", "certLab", "certNumber", "certUrl",
  "treatment", "growthMethod", "basePricePerCtUsd", "basePriceUsd", "state", "country",
  "photoUrl", "videoUrl", "isAvailable"
];

const GEMSTONE_CHANGE_COLUMNS = [
  "feedRowIndex", "sku", "varietyRaw", "shapeRaw", "colorRaw", "weightCt", "lengthMm",
  "widthMm", "depthMm", "ratio", "basePriceUsd", "basePricePerCtUsd", "certLab",
  "certNumber", "certUrl", "imageUrl", "image2Url", "videoUrl", "origin", "treatment", "isAvailable"
];

// Builds `"<table>"."col" IS DISTINCT FROM EXCLUDED."col" OR ...` for the upsert
// WHERE clause. NULL-safe (IS DISTINCT FROM treats NULLs correctly).
function changedPredicate(table: string, columns: string[]): Prisma.Sql {
  return Prisma.join(
    columns.map(
      (c) =>
        Prisma.sql`${Prisma.raw(`"${table}"."${c}"`)} IS DISTINCT FROM ${Prisma.raw(`EXCLUDED."${c}"`)}`
    ),
    " OR "
  );
}

// Marks rows not present in this run's feed as unavailable. Uses `<> ALL($1)`
// (a single array bind) instead of Prisma's `notIn`, which expands to a
// `NOT IN ($1,$2,…,$10000)` literal list that is expensive to plan and ship.
async function markStale(table: "Diamond" | "Gemstone", seenIds: string[]): Promise<number> {
  const tbl = Prisma.raw(`"${table}"`);
  const affected = await withWriteRetry("markStale", () =>
    prisma.$executeRaw(Prisma.sql`
      UPDATE ${tbl}
      SET "isAvailable" = false
      WHERE "isAvailable" = true
        AND "feedRowId" <> ALL(${seenIds}::text[])
    `)
  );
  return affected;
}

async function bulkUpsertDiamonds(input: ParsedDiamond[]): Promise<number> {
  const rows = dedupeByFeedRowId(input);
  if (rows.length === 0) return 0;

  // Serialize the whole chunk as ONE json array parameter and expand it
  // server-side with jsonb_to_recordset. This keeps the SQL *text* identical no
  // matter how many rows are in the chunk, so pg_stat_statements records a single
  // entry for this statement. The old `VALUES (…),(…),…` form produced a fresh
  // ~413 KB query string per distinct row-count, which bloated pg_stat_statements
  // to ~900 MB / ~3k entries and made Supabase's periodic metrics scraper time out
  // (SQLSTATE 57014) — the real cause of the day-over-day CPU climb. See markStale.
  const payload = rows.map((r) => ({
    id: genCuid(),
    feedRowId: r.feedRowId,
    feedRowIndex: r.feedRowIndex ?? null,
    vendor: r.vendor,
    origin: r.origin,
    sku: r.sku,
    shapeRaw: r.shapeRaw ?? null,
    shapeMapped: mapDiamondShape(r.shapeRaw)?.filter ?? null,
    weightCt: r.weightCt ?? null,
    colorWhite: r.colorWhite ?? null,
    fancyColor: r.fancyColor ?? null,
    fancyIntensity: r.fancyIntensity ?? null,
    fancyOvertone: r.fancyOvertone ?? null,
    clarity: r.clarity ?? null,
    clarityRank: clarityRank(r.clarity) ?? null,
    cutGrade: r.cutGrade ?? null,
    polish: r.polish ?? null,
    symmetry: r.symmetry ?? null,
    fluorescence: r.fluorescence ?? null,
    lengthMm: r.lengthMm ?? null,
    widthMm: r.widthMm ?? null,
    depthMm: r.depthMm ?? null,
    ratio: r.ratio ?? null,
    depthPct: r.depthPct ?? null,
    tablePct: r.tablePct ?? null,
    girdle: r.girdle ?? null,
    culet: r.culet ?? null,
    certLab: r.certLab ?? null,
    certNumber: r.certNumber ?? null,
    certUrl: r.certUrl ?? null,
    treatment: r.treatment ?? null,
    growthMethod: r.growthMethod ?? null,
    basePricePerCtUsd: r.basePricePerCtUsd ?? null,
    basePriceUsd: r.basePriceUsd ?? null,
    state: r.state ?? null,
    country: r.country ?? null,
    photoUrl: r.photoUrl ?? null,
    videoUrl: r.videoUrl ?? null
  }));

  const sql = Prisma.sql`
    INSERT INTO "Diamond" (
      "id","feedRowId","feedRowIndex","vendor","origin","sku","shapeRaw","shapeMapped",
      "weightCt","colorWhite","fancyColor","fancyIntensity","fancyOvertone",
      "clarity","clarityRank","cutGrade","polish","symmetry","fluorescence",
      "lengthMm","widthMm","depthMm","ratio","depthPct","tablePct",
      "girdle","culet","certLab","certNumber","certUrl","treatment","growthMethod",
      "basePricePerCtUsd","basePriceUsd","state","country","photoUrl","videoUrl",
      "rawFeedRow","lastSeenAt","isAvailable","createdAt","updatedAt"
    )
    SELECT
      x."id", x."feedRowId", x."feedRowIndex", x."vendor", x."origin", x."sku",
      x."shapeRaw", x."shapeMapped", x."weightCt", x."colorWhite", x."fancyColor",
      x."fancyIntensity", x."fancyOvertone", x."clarity", x."clarityRank", x."cutGrade",
      x."polish", x."symmetry", x."fluorescence", x."lengthMm", x."widthMm", x."depthMm",
      x."ratio", x."depthPct", x."tablePct", x."girdle", x."culet", x."certLab",
      x."certNumber", x."certUrl", x."treatment", x."growthMethod", x."basePricePerCtUsd",
      x."basePriceUsd", x."state", x."country", x."photoUrl", x."videoUrl",
      '{}'::jsonb, NOW(), TRUE, NOW(), NOW()
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
      "id" text, "feedRowId" text, "feedRowIndex" int, "vendor" text, "origin" text,
      "sku" text, "shapeRaw" text, "shapeMapped" text, "weightCt" numeric,
      "colorWhite" text, "fancyColor" text, "fancyIntensity" text, "fancyOvertone" text,
      "clarity" text, "clarityRank" int, "cutGrade" text, "polish" text, "symmetry" text,
      "fluorescence" text, "lengthMm" numeric, "widthMm" numeric, "depthMm" numeric,
      "ratio" numeric, "depthPct" numeric, "tablePct" numeric, "girdle" text,
      "culet" text, "certLab" text, "certNumber" text, "certUrl" text, "treatment" text,
      "growthMethod" text, "basePricePerCtUsd" numeric, "basePriceUsd" numeric,
      "state" text, "country" text, "photoUrl" text, "videoUrl" text
    )
    ON CONFLICT ("feedRowId") DO UPDATE SET
      "feedRowIndex" = EXCLUDED."feedRowIndex",
      "vendor" = EXCLUDED."vendor",
      "origin" = EXCLUDED."origin",
      "sku" = EXCLUDED."sku",
      "shapeRaw" = EXCLUDED."shapeRaw",
      "shapeMapped" = EXCLUDED."shapeMapped",
      "weightCt" = EXCLUDED."weightCt",
      "colorWhite" = EXCLUDED."colorWhite",
      "fancyColor" = EXCLUDED."fancyColor",
      "fancyIntensity" = EXCLUDED."fancyIntensity",
      "fancyOvertone" = EXCLUDED."fancyOvertone",
      "clarity" = EXCLUDED."clarity",
      "clarityRank" = EXCLUDED."clarityRank",
      "cutGrade" = EXCLUDED."cutGrade",
      "polish" = EXCLUDED."polish",
      "symmetry" = EXCLUDED."symmetry",
      "fluorescence" = EXCLUDED."fluorescence",
      "lengthMm" = EXCLUDED."lengthMm",
      "widthMm" = EXCLUDED."widthMm",
      "depthMm" = EXCLUDED."depthMm",
      "ratio" = EXCLUDED."ratio",
      "depthPct" = EXCLUDED."depthPct",
      "tablePct" = EXCLUDED."tablePct",
      "girdle" = EXCLUDED."girdle",
      "culet" = EXCLUDED."culet",
      "certLab" = EXCLUDED."certLab",
      "certNumber" = EXCLUDED."certNumber",
      "certUrl" = EXCLUDED."certUrl",
      "treatment" = EXCLUDED."treatment",
      "growthMethod" = EXCLUDED."growthMethod",
      "basePricePerCtUsd" = EXCLUDED."basePricePerCtUsd",
      "basePriceUsd" = EXCLUDED."basePriceUsd",
      "state" = EXCLUDED."state",
      "country" = EXCLUDED."country",
      "photoUrl" = EXCLUDED."photoUrl",
      "videoUrl" = EXCLUDED."videoUrl",
      "lastSeenAt" = NOW(),
      "isAvailable" = TRUE,
      "updatedAt" = NOW()
    WHERE ${changedPredicate("Diamond", DIAMOND_CHANGE_COLUMNS)}
  `;
  // Returns rows actually inserted/updated; unchanged rows are skipped by WHERE.
  return withWriteRetry("bulkUpsertDiamonds", () => prisma.$executeRaw(sql));
}

async function bulkUpsertGemstones(input: ParsedGemstone[]): Promise<number> {
  const rows = dedupeByFeedRowId(input);
  if (rows.length === 0) return 0;

  // Same fixed-shape jsonb_to_recordset strategy as bulkUpsertDiamonds — one json
  // parameter, constant SQL text, single pg_stat_statements entry. image3Url/
  // image4Url are not fed by the RapNet feed (always NULL on insert), so they are
  // emitted as constants in the SELECT rather than carried in the json payload.
  const payload = rows.map((r) => ({
    id: genCuid(),
    feedRowId: r.feedRowId,
    feedRowIndex: r.feedRowIndex ?? null,
    sku: r.sku,
    varietyRaw: r.varietyRaw ?? null,
    shapeRaw: r.shapeRaw ?? null,
    colorRaw: r.colorRaw ?? null,
    weightCt: r.weightCt ?? null,
    lengthMm: r.lengthMm ?? null,
    widthMm: r.widthMm ?? null,
    depthMm: r.depthMm ?? null,
    ratio: r.ratio ?? null,
    basePriceUsd: r.basePriceUsd ?? null,
    basePricePerCtUsd: r.basePricePerCtUsd ?? null,
    certLab: r.certLab ?? null,
    certNumber: r.certNumber ?? null,
    certUrl: r.certUrl ?? null,
    imageUrl: r.imageUrl ?? null,
    image2Url: r.image2Url ?? null,
    videoUrl: r.videoUrl ?? null,
    origin: r.origin ?? null,
    treatment: r.treatment ?? null
  }));

  const sql = Prisma.sql`
    INSERT INTO "Gemstone" (
      "id","feedRowId","feedRowIndex","sku","varietyRaw","shapeRaw","colorRaw",
      "weightCt","lengthMm","widthMm","depthMm","ratio",
      "basePriceUsd","basePricePerCtUsd","certLab","certNumber","certUrl",
      "imageUrl","image2Url","image3Url","image4Url","videoUrl",
      "origin","treatment","rawFeedRow","lastSeenAt","isAvailable",
      "createdAt","updatedAt"
    )
    SELECT
      x."id", x."feedRowId", x."feedRowIndex", x."sku", x."varietyRaw", x."shapeRaw",
      x."colorRaw", x."weightCt", x."lengthMm", x."widthMm", x."depthMm", x."ratio",
      x."basePriceUsd", x."basePricePerCtUsd", x."certLab", x."certNumber", x."certUrl",
      x."imageUrl", x."image2Url", NULL::text, NULL::text, x."videoUrl",
      x."origin", x."treatment", '{}'::jsonb, NOW(), TRUE, NOW(), NOW()
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
      "id" text, "feedRowId" text, "feedRowIndex" int, "sku" text, "varietyRaw" text,
      "shapeRaw" text, "colorRaw" text, "weightCt" numeric, "lengthMm" numeric,
      "widthMm" numeric, "depthMm" numeric, "ratio" numeric, "basePriceUsd" numeric,
      "basePricePerCtUsd" numeric, "certLab" text, "certNumber" text, "certUrl" text,
      "imageUrl" text, "image2Url" text, "videoUrl" text, "origin" text, "treatment" text
    )
    ON CONFLICT ("feedRowId") DO UPDATE SET
      "feedRowIndex" = EXCLUDED."feedRowIndex",
      "sku" = EXCLUDED."sku",
      "varietyRaw" = EXCLUDED."varietyRaw",
      "shapeRaw" = EXCLUDED."shapeRaw",
      "colorRaw" = EXCLUDED."colorRaw",
      "weightCt" = EXCLUDED."weightCt",
      "lengthMm" = EXCLUDED."lengthMm",
      "widthMm" = EXCLUDED."widthMm",
      "depthMm" = EXCLUDED."depthMm",
      "ratio" = EXCLUDED."ratio",
      "basePriceUsd" = EXCLUDED."basePriceUsd",
      "basePricePerCtUsd" = EXCLUDED."basePricePerCtUsd",
      "certLab" = EXCLUDED."certLab",
      "certNumber" = EXCLUDED."certNumber",
      "certUrl" = EXCLUDED."certUrl",
      "imageUrl" = EXCLUDED."imageUrl",
      "image2Url" = EXCLUDED."image2Url",
      "videoUrl" = EXCLUDED."videoUrl",
      "origin" = EXCLUDED."origin",
      "treatment" = EXCLUDED."treatment",
      "lastSeenAt" = NOW(),
      "isAvailable" = TRUE,
      "updatedAt" = NOW()
    WHERE ${changedPredicate("Gemstone", GEMSTONE_CHANGE_COLUMNS)}
  `;
  // Returns rows actually inserted/updated; unchanged rows are skipped by WHERE.
  return withWriteRetry("bulkUpsertGemstones", () => prisma.$executeRaw(sql));
}

async function touchIngestState(key: string, stats: unknown): Promise<void> {
  await prisma.ingestState.upsert({
    where: { id: key },
    create: {
      id: key,
      lastRunStats: stats as Prisma.InputJsonValue
    },
    update: {
      lastRunAt: new Date(),
      lastRunStats: stats as Prisma.InputJsonValue
    }
  });
}

// Per-feed ingest status lives in dedicated IngestState rows keyed "feed:<key>"
// (e.g. "feed:skylab"), distinct from the main "ingest" row. `lastFeedMtime`
// holds the feed file's upload time and `lastRunStats` carries the display label
// + parsed-row count. Best-effort: a failure here is logged and swallowed so it
// never affects the ingest outcome.
async function recordFeedStatuses(
  feeds: Map<string, { label: string; mtime: Date; rowsParsed: number }>
): Promise<void> {
  if (feeds.size === 0) return;
  try {
    await Promise.all(
      Array.from(feeds.entries()).map(([key, fd]) => {
        const stats = { label: fd.label, rowsParsed: fd.rowsParsed } as Prisma.InputJsonValue;
        return prisma.ingestState.upsert({
          where: { id: `feed:${key}` },
          create: { id: `feed:${key}`, lastFeedMtime: fd.mtime, lastRunStats: stats },
          update: { lastRunAt: new Date(), lastFeedMtime: fd.mtime, lastRunStats: stats }
        });
      })
    );
  } catch (err) {
    console.error("[ingest] failed to record per-feed status", err);
  }
}
