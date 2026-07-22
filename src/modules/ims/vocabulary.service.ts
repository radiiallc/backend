import { Prisma, prisma } from "@/db";
import type { ImsVocabularyValue, VocabKind } from "@/contract";

import { prismaVocabToDto } from "./mappers";

// `created` distinguishes a fresh insert (201) from a dedup hit (200).
export type AddVocabularyResult = {
  created: boolean;
  value: ImsVocabularyValue;
};

// Add a value to a self-growing list, or return the existing one. Dedup is
// case-insensitive within a kind (the @@unique([kind,value]) constraint is only
// case-sensitive, so the app dedups "Round"/"round" before inserting — matching
// the admin/importer pick-or-add). Trims first.
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
    // A concurrent add of the same (kind, exact-case value) raced us — re-read.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const raced = await prisma.vocabularyValue.findFirst({
        where: { kind, value: { equals: trimmed, mode: "insensitive" } }
      });
      if (raced) return { created: false, value: prismaVocabToDto(raced) };
    }
    throw e;
  }
}
