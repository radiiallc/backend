import { PrismaClient } from "@prisma/client";

// Re-export the full generated client surface (types, enums, Prisma namespace)
// so consumers import everything from "@/db" instead of "@prisma/client".
export * from "@prisma/client";

// Connection-pool defaults for the Supabase (pgbouncer) pooler. Prisma's stock
// serverless defaults — connection_limit=3 (1 vCPU * 2 + 1), pool_timeout=10 —
// cause P2024 "Timed out fetching a new connection from the connection pool"
// 500s on inventory pages under concurrent load (a Next.js `_rsc` prefetch
// races the real navigation, so a single click can need 2x the connections).
// We enforce these here so the app is not at the mercy of whether the deployed
// DATABASE_URL happens to carry the query string — production has regressed to
// the defaults before. Any param already present in the URL wins.
const POOL_PARAM_DEFAULTS: Record<string, string> = {
  pgbouncer: "true",
  connection_limit: "5",
  pool_timeout: "30",
  connect_timeout: "30"
};

function withPoolParams(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(POOL_PARAM_DEFAULTS)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    // Not a parseable URL — leave it untouched and let Prisma surface the error.
    return rawUrl;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const datasourceUrl = withPoolParams(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
