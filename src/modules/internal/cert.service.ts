import { prisma } from "@/db";

export async function resolveCertUrl(type: string, id: string): Promise<string | null> {
  if (type === "diamond") {
    const d = await prisma.diamond.findUnique({ where: { id }, select: { certUrl: true } });
    return d?.certUrl ?? null;
  }
  if (type === "gemstone") {
    const g = await prisma.gemstone.findUnique({ where: { id }, select: { certUrl: true } });
    return g?.certUrl ?? null;
  }
  return null;
}
