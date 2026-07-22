import { Prisma, prisma } from "@/db";
import type {
  ImsClient,
  ImsClientQuery,
  ImsInventoryItem,
  ImsInventoryQuery,
  ImsVendor,
  ImsVocabularyValue
} from "@/contract";

import {
  IMS_CLIENT_INCLUDE,
  IMS_ITEM_INCLUDE,
  IMS_VENDOR_INCLUDE,
  prismaClientToDto,
  prismaItemToDto,
  prismaVendorToDto,
  prismaVocabToDto
} from "./mappers";

// ── Inventory ─────────────────────────────────────────────────────────────────

function buildInventoryWhere(query: ImsInventoryQuery): Prisma.InventoryItemWhereInput {
  const where: Prisma.InventoryItemWhereInput = {};
  if (query.type) where.itemType = query.type;
  if (query.status) where.status = query.status;
  if (query.visible) where.visibleOnPortal = query.visible === "true";
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" as const };
    where.OR = [{ sku: contains }, { vendorSku: contains }, { itemName: contains }];
  }
  return where;
}

export async function listInventoryFromDb(query: ImsInventoryQuery): Promise<ImsInventoryItem[]> {
  const items = await prisma.inventoryItem.findMany({
    where: buildInventoryWhere(query),
    include: IMS_ITEM_INCLUDE,
    orderBy: { enteredStockAt: "desc" }
  });
  return items.map(prismaItemToDto);
}

export async function getInventoryItemByIdFromDb(id: string): Promise<ImsInventoryItem | null> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: IMS_ITEM_INCLUDE
  });
  return item ? prismaItemToDto(item) : null;
}

// ── Vendors ───────────────────────────────────────────────────────────────────

export async function listVendorsFromDb(): Promise<ImsVendor[]> {
  const vendors = await prisma.vendor.findMany({
    include: IMS_VENDOR_INCLUDE,
    orderBy: { name: "asc" }
  });
  return vendors.map(prismaVendorToDto);
}

export async function getVendorByIdFromDb(id: string): Promise<ImsVendor | null> {
  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: IMS_VENDOR_INCLUDE
  });
  return vendor ? prismaVendorToDto(vendor) : null;
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

export async function listVocabularyFromDb(kind?: string): Promise<ImsVocabularyValue[]> {
  const values = await prisma.vocabularyValue.findMany({
    where: kind ? { kind } : undefined,
    orderBy: [{ kind: "asc" }, { value: "asc" }]
  });
  return values.map(prismaVocabToDto);
}

// ── Clients ───────────────────────────────────────────────────────────────────

function buildClientWhere(query: ImsClientQuery): Prisma.CompanyWhereInput {
  const where: Prisma.CompanyWhereInput = {};
  if (query.status) where.clientStatus = query.status;
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" as const };
    where.OR = [{ name: contains }, { contactEmail: contains }, { contactName: contains }];
  }
  return where;
}

export async function listClientsFromDb(query: ImsClientQuery): Promise<ImsClient[]> {
  const clients = await prisma.company.findMany({
    where: buildClientWhere(query),
    include: IMS_CLIENT_INCLUDE,
    // Most recent signup first — the admin surfaces new PENDING accounts to review.
    orderBy: { createdAt: "desc" }
  });
  return clients.map(prismaClientToDto);
}

export async function getClientByIdFromDb(id: string): Promise<ImsClient | null> {
  const client = await prisma.company.findUnique({
    where: { id },
    include: IMS_CLIENT_INCLUDE
  });
  return client ? prismaClientToDto(client) : null;
}
