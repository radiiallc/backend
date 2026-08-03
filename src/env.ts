// Env validation for the standalone backend. Ported from the portal's
// src/lib/env.ts (HR-3); the backend now owns the data + integration secrets.
// Frontend-only vars (NEXT_PUBLIC_*) stay in the Next apps.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Environment variable ${name} is required but not set. Check .env.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function numberOptional(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// In-process ingest scheduler (see scheduler.ts). On by default in production
// (the always-on Railway server is the reliable clock GitHub Actions was not),
// off in dev/test unless explicitly turned on, and force-off with "false".
function resolveSchedulerEnabled(): boolean {
  const flag = process.env.INGEST_SCHEDULER_ENABLED;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

function resolveAppUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProd) return `https://${vercelProd}`;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export const env = {
  port: numberOptional("PORT", 4000),
  nodeEnv: optional("NODE_ENV", "development"),

  // Public URL of the client portal — used in email links + the password-reset
  // URL. publicAppUrl is the raw env (controls whether email logo is embedded).
  appUrl: resolveAppUrl(),
  publicAppUrl: optional("NEXT_PUBLIC_APP_URL", optional("APP_URL", "")),

  databaseUrl: required("DATABASE_URL"),
  authSecret: required("AUTH_SECRET"),
  resendApiKey: required("RESEND_API_KEY"),
  cronSecret: required("CRON_SECRET"),

  notificationEmail: optional("RADIIA_NOTIFICATION_EMAIL", "production@radiia.co"),
  inventoryEmail: optional("RADIIA_INVENTORY_EMAIL", "inventory@radiia.co"),
  ingestAlertThrottleHours: numberOptional("INGEST_ALERT_THROTTLE_HOURS", 6),
  // How many CONSECUTIVE alert-worthy runs before the first email goes out. The
  // feed re-runs every 15 min, so a one-off vendor hiccup is already fixed by the
  // time anyone reads the alert — holding one run means only sustained breakage
  // pages a human. 1 restores the old alert-on-first-failure behaviour.
  ingestAlertMinConsecutiveFailures: numberOptional("INGEST_ALERT_MIN_CONSECUTIVE_FAILURES", 2),

  // In-process ingest scheduler — replaces the unreliable GitHub Actions cron
  // (which was silently dropping ~80% of scheduled runs). Interval is clamped to
  // a sane floor in scheduler.ts so a misconfig can't hammer the FTP feed.
  ingestSchedulerEnabled: resolveSchedulerEnabled(),
  ingestIntervalMinutes: numberOptional("INGEST_INTERVAL_MINUTES", 15),

  // Periodic pg_stat_statements reset (maintenance, see scheduler.ts). Supabase's
  // metrics scraper walks every query text in pg_stat_statements; when that view
  // grows large the scrape times out (57014) and burns CPU. The fixed-shape ingest
  // upserts mean it no longer bloats, but a slow periodic reset is cheap insurance
  // and auto-clears any pre-existing bloat. 0 disables; default every 24h.
  pgStatResetHours: numberOptional("PG_STAT_RESET_HOURS", 24),
  resendFromEmail: optional("RESEND_FROM_EMAIL", "RADIIA Portal <onboarding@resend.dev>"),

  // Shared secret for the service-to-service /internal API surface (share page,
  // Sherry feed, cert proxy). The portal sends it as `x-internal-secret`; empty
  // => the /internal routes fail closed (401). Set the same value in both apps.
  internalApiSecret: optional("INTERNAL_API_SECRET", ""),

  // Cookie scope for the shared session (D8): httpOnly cookie on .radiia.co so
  // apps/portal + apps/admin subdomains share it. Empty in dev (host-only cookie).
  cookieDomain: optional("AUTH_COOKIE_DOMAIN", ""),

  // CORS — comma-separated browser origins allowed to call the api with
  // credentials (the portal + admin frontends). Defaults to the dev portal.
  allowedOrigins: optional("ALLOWED_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Supabase Storage for RADIIA-owned inventory media (H3.3). Optional so the
  // app boots without it; the media endpoints return 503 until configured. The
  // bucket must be PRIVATE (media is served via short-lived signed URLs, never a
  // public bucket). The service-role key is server-only — never sent to a client.
  supabaseUrl: optional("SUPABASE_URL", "").replace(/\/+$/, ""),
  supabaseServiceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY", ""),
  supabaseStorageBucket: optional("SUPABASE_STORAGE_BUCKET", "inventory-media"),

  gemstoneFtpHost: optional("GEMSTONE_FTP_HOST", ""),
  gemstoneFtpUser: optional("GEMSTONE_FTP_USER", ""),
  gemstoneFtpPassword: optional("GEMSTONE_FTP_PASSWORD", ""),
  gemstoneFtpPath: optional("GEMSTONE_FTP_PATH", ""),
  ingestFtpDir: optional("INGEST_FTP_DIR", "/upload"),

  // --- Skylab direct API (FTP→API migration, WORKPLAN §1.6) ---------------
  // Skylab (lab diamonds) is leaving Fantasy, so its Fantasy-hosted FTP feed
  // will die; we move it onto Skylab's own pull API. `skylabSource` selects the
  // Skylab ingest source. DEFAULT "ftp" — the API path is dormant until a run is
  // deliberately cut over, so shipping this never changes prod behavior. Set to
  // "api" only after the reconcile report (scripts/skylab-api.ts reconcile) looks
  // clean. Disons + Gemstones are unaffected either way — only Skylab moves.
  skylabSource: (optional("SKYLAB_SOURCE", "ftp").toLowerCase() === "api"
    ? "api"
    : "ftp") as "ftp" | "api",
  skylabApiUrl: optional("SKYLAB_API_URL", "https://jwlapi.itemlinkshare.com").replace(/\/+$/, ""),
  skylabApiPath: optional("SKYLAB_API_PATH", "/users/radiia-list"),
  // Provided by Skylab (Jignesh). Empty => the API fetch fails loud rather than
  // silently ingesting nothing; server-only, never exposed to a browser.
  skylabApiKey: optional("SKYLAB_API_KEY", ""),
  skylabApiTimeoutMs: numberOptional("SKYLAB_API_TIMEOUT_MS", 30_000),
  // Transient-failure retry for the API pull. Skylab's gateway intermittently
  // returns 5xx (a 502 on 2026-07-31 failed a whole run, alerted, then cleared on
  // the next tick unaided), so an in-process retry turns a vendor blip into a
  // non-event. Total attempts including the first; 1 disables retrying. Only
  // infrastructure-shaped failures retry — see skylab-api.ts.
  skylabApiRetryAttempts: numberOptional("SKYLAB_API_RETRY_ATTEMPTS", 3),
  // lot_status values the API uses for a live/orderable stone. Everything else
  // (on-memo / on-hold / sold) is treated as unavailable and swept — this is the
  // whole point of the migration (the FTP feed had no such signal). Comma-
  // separated, case-insensitive. Confirm the full vocabulary with Skylab; the
  // fetch/reconcile script prints the observed distribution so it can be verified.
  skylabAvailableStatuses: optional("SKYLAB_AVAILABLE_STATUSES", "STOCK")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  // Abort an api-mode Skylab run if usable rows fall below this fraction of the
  // count currently available in the DB — partial-batch protection (Gate §5).
  // 0.5 = tolerate up to a 50% drop in one cycle; lower if the book is volatile.
  skylabMinRowsFraction: numberOptional("SKYLAB_MIN_ROWS_FRACTION", 0.5),

  sherryFeedToken: optional("SHERRY_FEED_TOKEN", ""),
  sherryFeedNaturalMarkupPct: numberOptional("SHERRY_FEED_NATURAL_MARKUP_PCT", 5),
  sherryFeedLabMarkupPct: numberOptional("SHERRY_FEED_LAB_MARKUP_PCT", 15),

  // --- GIA Report Results API (grade-report lookup, IMS ⑤) -----------------
  // The admin looks up a GIA report number to pre-fill a diamond's grading
  // fields. GIA's GraphQL API (POST, `Authorization: <key>`) serves BOTH sandbox
  // and production from one endpoint — the KEY scopes which reports are visible
  // (a sandbox key can only read GIA's published sandbox reports). So the cutover
  // to live data is a KEY swap, not an endpoint change. The key is server-only —
  // never exposed to a browser; the admin calls our /ims/gia/lookup proxy. Empty
  // key => the proxy returns a clean "not configured" error rather than calling
  // out. Endpoint defaults to the host Jennifer was given; confirm the exact URL
  // from GIA's signup email if a call 404s. Timeout keeps a slow GIA call from
  // hanging the admin request.
  giaApiEndpoint: optional("GIA_API_ENDPOINT", "https://api.reportresults.gia.edu/"),
  giaApiKey: optional("GIA_API_KEY", ""),
  giaApiTimeoutMs: numberOptional("GIA_API_TIMEOUT_MS", 15_000)
} as const;
