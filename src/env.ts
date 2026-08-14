
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

  appUrl: resolveAppUrl(),
  publicAppUrl: optional("NEXT_PUBLIC_APP_URL", optional("APP_URL", "")),

  databaseUrl: required("DATABASE_URL"),
  authSecret: required("AUTH_SECRET"),
  resendApiKey: required("RESEND_API_KEY"),
  cronSecret: required("CRON_SECRET"),

  notificationEmail: optional("RADIIA_NOTIFICATION_EMAIL", "production@radiia.co"),
  inventoryEmail: optional("RADIIA_INVENTORY_EMAIL", "inventory@radiia.co"),
  ingestAlertThrottleHours: numberOptional("INGEST_ALERT_THROTTLE_HOURS", 6),
  ingestAlertMinConsecutiveFailures: numberOptional("INGEST_ALERT_MIN_CONSECUTIVE_FAILURES", 2),

  ingestSchedulerEnabled: resolveSchedulerEnabled(),
  ingestIntervalMinutes: numberOptional("INGEST_INTERVAL_MINUTES", 15),

  pgStatResetHours: numberOptional("PG_STAT_RESET_HOURS", 24),
  resendFromEmail: optional("RESEND_FROM_EMAIL", "RADIIA Portal <onboarding@resend.dev>"),

  internalApiSecret: optional("INTERNAL_API_SECRET", ""),

  cookieDomain: optional("AUTH_COOKIE_DOMAIN", ""),

  allowedOrigins: optional("ALLOWED_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  supabaseUrl: optional("SUPABASE_URL", "").replace(/\/+$/, ""),
  supabaseServiceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY", ""),
  supabaseStorageBucket: optional("SUPABASE_STORAGE_BUCKET", "inventory-media"),

  gemstoneFtpHost: optional("GEMSTONE_FTP_HOST", ""),
  gemstoneFtpUser: optional("GEMSTONE_FTP_USER", ""),
  gemstoneFtpPassword: optional("GEMSTONE_FTP_PASSWORD", ""),
  gemstoneFtpPath: optional("GEMSTONE_FTP_PATH", ""),
  ingestFtpDir: optional("INGEST_FTP_DIR", "/upload"),

  skylabSource: (optional("SKYLAB_SOURCE", "ftp").toLowerCase() === "api"
    ? "api"
    : "ftp") as "ftp" | "api",
  skylabApiUrl: optional("SKYLAB_API_URL", "https://jwlapi.itemlinkshare.com").replace(/\/+$/, ""),
  skylabApiPath: optional("SKYLAB_API_PATH", "/users/radiia-list"),
  skylabApiKey: optional("SKYLAB_API_KEY", ""),
  skylabApiTimeoutMs: numberOptional("SKYLAB_API_TIMEOUT_MS", 30_000),
  skylabApiRetryAttempts: numberOptional("SKYLAB_API_RETRY_ATTEMPTS", 3),
  skylabAvailableStatuses: optional("SKYLAB_AVAILABLE_STATUSES", "STOCK")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  skylabMinRowsFraction: numberOptional("SKYLAB_MIN_ROWS_FRACTION", 0.5),

  sherryFeedToken: optional("SHERRY_FEED_TOKEN", ""),
  sherryFeedNaturalMarkupPct: numberOptional("SHERRY_FEED_NATURAL_MARKUP_PCT", 5),
  sherryFeedLabMarkupPct: numberOptional("SHERRY_FEED_LAB_MARKUP_PCT", 15),

  giaApiEndpoint: optional("GIA_API_ENDPOINT", "https://api.reportresults.gia.edu/"),
  giaApiKey: optional("GIA_API_KEY", ""),
  giaApiTimeoutMs: numberOptional("GIA_API_TIMEOUT_MS", 15_000)
} as const;
