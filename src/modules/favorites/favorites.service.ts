import { prisma } from "@/db";
import type { FavoriteActionResult, FavoriteBulkResult } from "@/contract";

// Port of the portal favorites mutations, parameterized by the authenticated
// userId (the route enforces auth + BUYER/ADMIN). revalidatePath dropped;
// polymorphic gemstone-XOR-diamond resolution and idempotent add are unchanged.

async function resolveFavoriteData(
  itemId: string
): Promise<{ gemstoneId: string } | { diamondId: string } | null> {
  const gem = await prisma.gemstone.findUnique({ where: { id: itemId }, select: { id: true } });
  if (gem) return { gemstoneId: itemId };
  const dia = await prisma.diamond.findUnique({ where: { id: itemId }, select: { id: true } });
  if (dia) return { diamondId: itemId };
  return null;
}

export async function addFavorite(userId: string, itemId: string): Promise<FavoriteActionResult> {
  if (!itemId) return { ok: false, error: "Missing item id" };

  const existing = await prisma.favorite.findFirst({
    where: { userId, OR: [{ gemstoneId: itemId }, { diamondId: itemId }] },
    select: { id: true }
  });
  if (existing) return { ok: true, favored: true };

  const data = await resolveFavoriteData(itemId);
  if (!data) return { ok: false, error: "Item not found" };

  await prisma.favorite.create({ data: { userId, ...data } });
  return { ok: true, favored: true };
}

export async function removeFavorite(userId: string, itemId: string): Promise<FavoriteActionResult> {
  if (!itemId) return { ok: false, error: "Missing item id" };

  await prisma.favorite.deleteMany({
    where: { userId, OR: [{ gemstoneId: itemId }, { diamondId: itemId }] }
  });
  return { ok: true, favored: false };
}

export async function toggleFavorite(userId: string, itemId: string): Promise<FavoriteActionResult> {
  if (!itemId) return { ok: false, error: "Missing item id" };

  const existing = await prisma.favorite.findFirst({
    where: { userId, OR: [{ gemstoneId: itemId }, { diamondId: itemId }] },
    select: { id: true }
  });

  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    return { ok: true, favored: false };
  }

  const data = await resolveFavoriteData(itemId);
  if (!data) return { ok: false, error: "Item not found" };

  await prisma.favorite.create({ data: { userId, ...data } });
  return { ok: true, favored: true };
}

export async function addFavoritesBulk(
  userId: string,
  itemIds: string[]
): Promise<FavoriteBulkResult> {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  if (ids.length === 0) return { ok: true, added: 0, failures: [] };

  const gemRows = await prisma.gemstone.findMany({
    where: { id: { in: ids } },
    select: { id: true }
  });
  const gemIds = new Set(gemRows.map((g) => g.id));
  const nonGemIds = ids.filter((id) => !gemIds.has(id));
  const diaRows = await prisma.diamond.findMany({
    where: { id: { in: nonGemIds } },
    select: { id: true }
  });
  const diaIds = new Set(diaRows.map((d) => d.id));

  const failures = ids.filter((id) => !gemIds.has(id) && !diaIds.has(id));
  const data = [
    ...[...gemIds].map((gemstoneId) => ({ userId, gemstoneId })),
    ...[...diaIds].map((diamondId) => ({ userId, diamondId }))
  ];

  if (data.length === 0) {
    return { ok: true, added: 0, failures };
  }

  const result = await prisma.favorite.createMany({ data, skipDuplicates: true });
  return { ok: true, added: result.count, failures };
}
