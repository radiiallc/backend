import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

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
