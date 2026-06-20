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
    include: { items: true },
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
    include: { items: true },
    orderBy: { submittedAt: "desc" },
    take: limit
  });
  return requests.map(prismaRequestToAdminRequest);
}

export async function getRequestByIdFromDb(id: string): Promise<AdminRequest | null> {
  const request = await prisma.request.findUnique({
    where: { id },
    include: { items: true }
  });
  return request ? prismaRequestToAdminRequest(request) : null;
}

export async function getDashboardKpisFromDb(): Promise<DashboardKpis> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [pendingAccounts, pendingRequests, requestsThisWeek, ingestState] = await Promise.all([
    prisma.user.count({ where: { role: "BUYER", status: "PENDING" } }),
    prisma.request.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
    prisma.request.count({ where: { submittedAt: { gte: weekAgo } } }),
    prisma.ingestState.findFirst({ orderBy: { lastRunAt: "desc" } })
  ]);

  const stats = (ingestState?.lastRunStats ?? null) as { rowsUpserted?: number } | null;
  const lastIngestRowCount =
    typeof stats?.rowsUpserted === "number" ? stats.rowsUpserted : null;

  return {
    pendingAccounts,
    pendingRequests,
    requestsThisWeek,
    lastIngestRunAt: ingestState?.lastRunAt?.toISOString() ?? null,
    lastIngestRowCount
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
