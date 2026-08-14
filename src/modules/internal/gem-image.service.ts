import { prisma } from "@/db";

export async function resolveGemstoneImage2Url(id: string): Promise<string | null> {
  const g = await prisma.gemstone.findUnique({
    where: { id },
    select: { image2Url: true }
  });
  return g?.image2Url ?? null;
}
