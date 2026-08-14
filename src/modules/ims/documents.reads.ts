import { Prisma, prisma } from "@/db";
import type { DocumentType as PrismaDocumentType } from "@/db";
import type { ImsDocument, ImsDocumentQuery } from "@/contract";

import { IMS_DOC_INCLUDE, prismaDocToDto } from "./documents.mappers";

const INBOUND_TYPES: PrismaDocumentType[] = ["MEMO_IN", "BILL_IN", "BRAND_INVENTORY_IN"];

function buildDocumentWhere(query: ImsDocumentQuery): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {};
  if (query.type) where.type = query.type;
  if (query.status) where.status = query.status;
  if (query.direction) {
    where.type = query.direction === "in" ? { in: INBOUND_TYPES } : { notIn: INBOUND_TYPES };
  }
  return where;
}

export async function listDocumentsFromDb(query: ImsDocumentQuery): Promise<ImsDocument[]> {
  const docs = await prisma.document.findMany({
    where: buildDocumentWhere(query),
    include: IMS_DOC_INCLUDE,
    orderBy: { issueDate: "desc" }
  });
  return docs.map(prismaDocToDto);
}

export async function getDocumentByIdFromDb(id: string): Promise<ImsDocument | null> {
  const doc = await prisma.document.findUnique({
    where: { id },
    include: IMS_DOC_INCLUDE
  });
  return doc ? prismaDocToDto(doc) : null;
}
