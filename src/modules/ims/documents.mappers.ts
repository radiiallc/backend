import { Prisma } from "@/db";
import type { ImsDocument, ImsDocumentLineItem, PartyKind } from "@/contract";

import { docDirectionOf } from "./documents.constants";

export const IMS_DOC_INCLUDE = {
  vendor: { select: { name: true } },
  client: { select: { name: true } },
  parentDocument: { select: { documentNumber: true } },
  lineItems: {
    orderBy: { createdAt: "asc" },
    include: {
      inventoryItem: { select: { sku: true, itemName: true } },
      resolvedByDocument: { select: { documentNumber: true } }
    }
  }
} satisfies Prisma.DocumentInclude;

type PrismaDocWithRelations = Prisma.DocumentGetPayload<{ include: typeof IMS_DOC_INCLUDE }>;
type PrismaLineWithRelations = PrismaDocWithRelations["lineItems"][number];

function decOrNull(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function prismaLineToDto(line: PrismaLineWithRelations): ImsDocumentLineItem {
  return {
    id: line.id,
    inventoryItemId: line.inventoryItemId,
    itemSku: line.inventoryItem.sku,
    itemName: line.inventoryItem.itemName,
    lineStatus: line.lineStatus,
    resolvedByDocumentId: line.resolvedByDocumentId,
    resolvedByDocumentNumber: line.resolvedByDocument?.documentNumber ?? null,
    quantity: line.quantity,
    caratWeight: decOrNull(line.caratWeight),
    unitPrice: decOrNull(line.unitPrice),
    totalPrice: decOrNull(line.totalPrice),
    discountAmount: decOrNull(line.discountAmount),
    clientReference: line.clientReference,
    notes: line.notes
  };
}

export function prismaDocToDto(doc: PrismaDocWithRelations): ImsDocument {
  const direction = docDirectionOf(doc.type);
  const partyKind: PartyKind | null = doc.vendorId ? "vendor" : doc.clientId ? "client" : null;
  const partyName = doc.vendor?.name ?? doc.client?.name ?? null;
  const discount = decOrNull(doc.discountAmount);

  const lineItems = doc.lineItems.map(prismaLineToDto);
  const priced = lineItems.filter((l) => l.totalPrice !== null);
  const subtotal = priced.reduce((sum, l) => sum + (l.totalPrice ?? 0), 0);
  let total: number | null = null;
  if (priced.length > 0) {
    total = direction === "out" ? Math.max(0, subtotal - (discount ?? 0)) : subtotal;
  }

  return {
    id: doc.id,
    type: doc.type,
    documentNumber: doc.documentNumber,
    externalReference: doc.externalReference,
    status: doc.status,
    direction,
    partyKind,
    vendorId: doc.vendorId,
    clientId: doc.clientId,
    partyName,
    issueDate: doc.issueDate.toISOString(),
    dueDate: doc.dueDate?.toISOString() ?? null,
    discountAmount: discount,
    notes: doc.notes,
    emailedAt: doc.emailedAt?.toISOString() ?? null,
    quickbooksSyncedAt: doc.quickbooksSyncedAt?.toISOString() ?? null,
    closeReason: doc.closeReason,
    parentDocumentId: doc.parentDocumentId,
    parentDocumentNumber: doc.parentDocument?.documentNumber ?? null,
    createdById: doc.createdById,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    lineCount: lineItems.length,
    total,
    lineItems
  };
}
