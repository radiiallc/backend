import { prisma } from "@/db";
import type { AdminAccount, AdminCompany, AdminRequest, DashboardKpis } from "@/contract";

import {
  prismaCompanyToAdminCompany,
  prismaRequestToAdminRequest,
  prismaUserToAdminAccount
} from "./mappers";

export async function listAccountsFromDb(): Promise<AdminAccount[]> {
  const users = await prisma.user.findMany({
    where: { role: "BUYER" },
    orderBy: { createdAt: "desc" }
  });
  return users.map(prismaUserToAdminAccount);
}

export async function getAccountByIdFromDb(id: string): Promise<AdminAccount | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.role !== "BUYER") return null;
  return prismaUserToAdminAccount(user);
}

export async function listCompaniesFromDb(): Promise<AdminCompany[]> {
  const companies = await prisma.company.findMany({ orderBy: { name: "asc" } });
  return companies.map(prismaCompanyToAdminCompany);
}

export async function getCompanyByIdFromDb(id: string): Promise<AdminCompany | null> {
  const company = await prisma.company.findUnique({ where: { id } });
  return company ? prismaCompanyToAdminCompany(company) : null;
}

export async function listRequestsFromDb(): Promise<AdminRequest[]> {
  const requests = await prisma.request.findMany({
    include: { items: true, convertedDocument: { select: { documentNumber: true } } },
    orderBy: { submittedAt: "desc" }
  });
  return requests.map(prismaRequestToAdminRequest);
}

export async function listRecentRequestsByCompanyFromDb(
  companyId: string,
  limit = 3
): Promise<AdminRequest[]> {
  const requests = await prisma.request.findMany({
    where: { companyId },
    include: { items: true, convertedDocument: { select: { documentNumber: true } } },
    orderBy: { submittedAt: "desc" },
    take: limit
  });
  return requests.map(prismaRequestToAdminRequest);
}

export async function getRequestByIdFromDb(id: string): Promise<AdminRequest | null> {
  const request = await prisma.request.findUnique({
    where: { id },
    include: { items: true, convertedDocument: { select: { documentNumber: true } } }
  });
  return request ? prismaRequestToAdminRequest(request) : null;
}

const FEED_ORDER = ["skylab", "disons", "gemstones"];

export async function getDashboardKpisFromDb(): Promise<DashboardKpis> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [pendingAccounts, pendingRequests, requestsThisWeek, ingestState, feedStates] =
    await Promise.all([
      prisma.user.count({ where: { role: "BUYER", status: "PENDING" } }),
      prisma.request.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      prisma.request.count({ where: { submittedAt: { gte: weekAgo } } }),
      prisma.ingestState.findUnique({ where: { id: "ingest" } }),
      prisma.ingestState.findMany({ where: { id: { startsWith: "feed:" } } })
    ]);

  const stats = (ingestState?.lastRunStats ?? null) as { rowsUpsertedTotal?: number } | null;
  const lastIngestRowCount =
    typeof stats?.rowsUpsertedTotal === "number" ? stats.rowsUpsertedTotal : null;

  const ingestFeeds = feedStates
    .map((s) => {
      const key = s.id.slice("feed:".length);
      const feedStats = (s.lastRunStats ?? null) as { label?: string; rowsParsed?: number } | null;
      return {
        feed: key,
        label: feedStats?.label ?? key,
        lastUploadAt: s.lastFeedMtime?.toISOString() ?? null,
        rowsParsed: typeof feedStats?.rowsParsed === "number" ? feedStats.rowsParsed : 0
      };
    })
    .sort((a, b) => {
      const ai = FEED_ORDER.indexOf(a.feed);
      const bi = FEED_ORDER.indexOf(b.feed);
      return (ai === -1 ? FEED_ORDER.length : ai) - (bi === -1 ? FEED_ORDER.length : bi);
    });

  return {
    pendingAccounts,
    pendingRequests,
    requestsThisWeek,
    lastIngestRunAt: ingestState?.lastRunAt?.toISOString() ?? null,
    lastIngestRowCount,
    ingestFeeds
  };
}

export async function getRecentPendingSignups(): Promise<
  { id: string; fullName: string; email: string; companyName: string; createdAt: string }[]
> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const users = await prisma.user.findMany({
    where: {
      role: "BUYER",
      status: "PENDING",
      createdAt: { gte: sevenDaysAgo }
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { company: { select: { name: true } } }
  });
  return users.map((u) => ({
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    companyName: u.company?.name ?? "Unknown company",
    createdAt: u.createdAt.toISOString()
  }));
}
