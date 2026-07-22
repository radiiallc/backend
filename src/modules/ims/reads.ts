import { Prisma, prisma } from "@/db";
import type {
  ImsInventoryItem,
  ImsInventoryQuery,
  ImsVendor,
  ImsVocabularyValue
} from "@/contract";

import {
  IMS_ITEM_INCLUDE,
  IMS_VENDOR_INCLUDE,
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
