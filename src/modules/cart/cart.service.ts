import { prisma } from "@/db";
import type { CartActionResult, CartPreview, CartPreviewLine } from "@/contract";

import { getCartForBuyer, getCartItemCountForUser } from "./reads";

// Cart mutations/reads, parameterized by the authenticated userId (the route
// layer enforces auth + BUYER/ADMIN role and supplies it). Ported verbatim from
// the portal's cart server actions, minus the `auth()` session lookup and the
// `revalidatePath("/cart")` cache hint (the Next portal re-fetches on its own).

export async function getCartCount(userId: string): Promise<number> {
  return getCartItemCountForUser(userId);
}

const PREVIEW_LIMIT = 4;

export async function getCartPreview(
  userId: string,
  companyId: string | null
): Promise<CartPreview> {
  const cart = await getCartForBuyer(userId, companyId);
  const totalCount = cart.items.reduce((sum, it) => sum + (it.qty ?? 0), 0);
  const items: CartPreviewLine[] = cart.items.slice(0, PREVIEW_LIMIT).map((it) => {
    const weight = typeof it.weightCt === "number" ? `${it.weightCt.toFixed(2)}ct` : "";
    const variety = it.varietyRaw ?? "Gemstone";
    const title = [weight, variety].filter(Boolean).join(" ").trim() || it.sku;
    return {
      cartItemId: it.cartItemId,
      itemId: it.itemId,
      sku: it.sku,
      title,
      qty: it.qty,
      lineTotalUsd: it.lineTotalUsd,
      shapeRaw: it.shapeRaw,
      shapeMapped: it.shapeMapped,
      imageUrl: it.imageUrl,
      isAvailable: it.isAvailable
    };
  });
  return {
    items,
    subtotalUsd: cart.subtotalUsd,
    totalCount,
    lineCount: cart.items.length
  };
}

async function ensureCartId(userId: string): Promise<string> {
  const existing = await prisma.cart.findUnique({
    where: { userId },
    select: { id: true }
  });
  if (existing) return existing.id;
  const created = await prisma.cart.create({
    data: { userId },
    select: { id: true }
  });
  return created.id;
}

async function resolveCartItem(
  itemId: string
): Promise<{ kind: "gemstone" | "diamond"; isAvailable: boolean } | null> {
  const gem = await prisma.gemstone.findUnique({
    where: { id: itemId },
    select: { isAvailable: true }
  });
  if (gem) return { kind: "gemstone", isAvailable: gem.isAvailable };
  const dia = await prisma.diamond.findUnique({
    where: { id: itemId },
    select: { isAvailable: true }
  });
  if (dia) return { kind: "diamond", isAvailable: dia.isAvailable };
  return null;
}

export async function addToCart(
  userId: string,
  itemId: string,
  qty = 1
): Promise<CartActionResult> {
  if (!itemId) return { ok: false, error: "Missing item id" };
  const quantity = Math.max(1, Math.floor(qty));

  const resolved = await resolveCartItem(itemId);
  if (!resolved) return { ok: false, error: "Item not found" };
  if (!resolved.isAvailable) return { ok: false, error: "Item is no longer available" };

  const cartId = await ensureCartId(userId);

  if (resolved.kind === "gemstone") {
    await prisma.cartItem.upsert({
      where: { cartId_gemstoneId: { cartId, gemstoneId: itemId } },
      create: { cartId, gemstoneId: itemId, qty: quantity },
      update: { qty: { increment: quantity } }
    });
  } else {
    await prisma.cartItem.upsert({
      where: { cartId_diamondId: { cartId, diamondId: itemId } },
      create: { cartId, diamondId: itemId, qty: quantity },
      update: { qty: { increment: quantity } }
    });
  }

  return { ok: true };
}

export async function removeFromCart(
  userId: string,
  cartItemId: string
): Promise<CartActionResult> {
  if (!cartItemId) return { ok: false, error: "Missing cartItemId" };

  const item = await prisma.cartItem.findUnique({
    where: { id: cartItemId },
    select: { cart: { select: { userId: true } } }
  });
  if (!item || item.cart.userId !== userId) {
    return { ok: false, error: "Item not found" };
  }

  await prisma.cartItem.delete({ where: { id: cartItemId } });
  return { ok: true };
}

export async function updateCartItemQty(
  userId: string,
  cartItemId: string,
  qty: number
): Promise<CartActionResult> {
  if (!cartItemId) return { ok: false, error: "Missing cartItemId" };
  const quantity = Math.floor(qty);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { ok: false, error: "Quantity must be at least 1" };
  }

  const item = await prisma.cartItem.findUnique({
    where: { id: cartItemId },
    select: { cart: { select: { userId: true } } }
  });
  if (!item || item.cart.userId !== userId) {
    return { ok: false, error: "Item not found" };
  }

  await prisma.cartItem.update({
    where: { id: cartItemId },
    data: { qty: quantity }
  });
  return { ok: true };
}

export async function clearCart(userId: string): Promise<CartActionResult> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    select: { id: true }
  });
  if (!cart) return { ok: true };

  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  return { ok: true };
}
