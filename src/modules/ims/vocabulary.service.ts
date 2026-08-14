import { Prisma, prisma } from "@/db";
import type { ImsVocabularyValue, VocabKind } from "@/contract";

import { prismaVocabToDto } from "./mappers";

export type AddVocabularyResult = {
  created: boolean;
  value: ImsVocabularyValue;
};

export async function addVocabularyValue(
  kind: VocabKind,
  value: string
): Promise<AddVocabularyResult> {
  const trimmed = value.trim();

  const existing = await prisma.vocabularyValue.findFirst({
    where: { kind, value: { equals: trimmed, mode: "insensitive" } }
  });
  if (existing) return { created: false, value: prismaVocabToDto(existing) };

  try {
    const created = await prisma.vocabularyValue.create({ data: { kind, value: trimmed } });
    return { created: true, value: prismaVocabToDto(created) };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const raced = await prisma.vocabularyValue.findFirst({
        where: { kind, value: { equals: trimmed, mode: "insensitive" } }
      });
      if (raced) return { created: false, value: prismaVocabToDto(raced) };
    }
    throw e;
  }
}
