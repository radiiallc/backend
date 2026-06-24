import { prisma } from "@/db";
import type { MediaSlot, SignedUploadResponse } from "@/contract";

import {
  createSignedReadUrl,
  createSignedUploadUrl,
  deleteObject,
  isStorageConfigured
} from "../../integrations/storage/supabase-storage";

// Inventory media service (§H3.3). Stones only: up to 2 photos + 1 video (§4.7),
// stored on StoneDetail.{photo1Url,photo2Url,videoUrl}. We persist the storage
// OBJECT PATH (not a URL) on the row and mint short-lived signed URLs on demand
// (private bucket). Upload is a 3-step browser flow: request a signed upload URL
// → PUT the file straight to Supabase → confirm the path back to us.

const SLOT_COLUMN: Record<MediaSlot, "photo1Url" | "photo2Url" | "videoUrl"> = {
  photo1: "photo1Url",
  photo2: "photo2Url",
  video: "videoUrl"
};

export type MediaResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

async function loadStone(itemId: string) {
  return prisma.inventoryItem.findUnique({
    where: { id: itemId },
    select: { id: true, itemType: true, stoneDetail: { select: { id: true } } }
  });
}

export async function requestUploadUrl(
  itemId: string,
  slot: MediaSlot,
  filename: string
): Promise<MediaResult<SignedUploadResponse>> {
  if (!isStorageConfigured()) {
    return { ok: false, status: 503, error: "Media storage is not configured." };
  }
  const item = await loadStone(itemId);
  if (!item) return { ok: false, status: 404, error: "Item not found" };
  if (item.itemType !== "STONE") {
    return { ok: false, status: 400, error: "Only stones carry media." };
  }

  const path = `${itemId}/${slot}-${Date.now()}-${sanitizeFilename(filename)}`;
  try {
    const signed = await createSignedUploadUrl(path);
    return { ok: true, data: signed };
  } catch (err) {
    console.error("[ims/media] signed-upload failed", err);
    return { ok: false, status: 502, error: "Could not create an upload URL." };
  }
}

// Confirm an uploaded object onto the row. Creates the StoneDetail row if the
// stone has none yet (e.g. created without a detail block). Deletes any object
// previously in this slot so we don't orphan storage.
export async function setMediaPath(
  itemId: string,
  slot: MediaSlot,
  path: string
): Promise<MediaResult<{ slot: MediaSlot; path: string }>> {
  const item = await loadStone(itemId);
  if (!item) return { ok: false, status: 404, error: "Item not found" };
  if (item.itemType !== "STONE") {
    return { ok: false, status: 400, error: "Only stones carry media." };
  }

  const column = SLOT_COLUMN[slot];
  const previous = item.stoneDetail
    ? (
        await prisma.stoneDetail.findUnique({
          where: { inventoryItemId: itemId },
          select: { [column]: true } as Record<string, true>
        })
      )?.[column]
    : null;

  await prisma.stoneDetail.upsert({
    where: { inventoryItemId: itemId },
    create: { inventoryItemId: itemId, [column]: path },
    update: { [column]: path }
  });

  // Best-effort cleanup of the replaced object.
  if (previous && previous !== path && isStorageConfigured()) {
    deleteObject(previous as string).catch((err) =>
      console.warn("[ims/media] failed to delete replaced object", err)
    );
  }

  return { ok: true, data: { slot, path } };
}

export async function getMediaUrl(
  itemId: string,
  slot: MediaSlot
): Promise<MediaResult<{ url: string | null }>> {
  const column = SLOT_COLUMN[slot];
  const detail = await prisma.stoneDetail.findUnique({
    where: { inventoryItemId: itemId },
    select: { [column]: true } as Record<string, true>
  });
  const path = detail?.[column] as string | null | undefined;
  if (!path) return { ok: true, data: { url: null } };
  if (!isStorageConfigured()) {
    return { ok: false, status: 503, error: "Media storage is not configured." };
  }
  try {
    const url = await createSignedReadUrl(path);
    return { ok: true, data: { url } };
  } catch (err) {
    console.error("[ims/media] sign-read failed", err);
    return { ok: false, status: 502, error: "Could not create a media URL." };
  }
}

export async function removeMedia(
  itemId: string,
  slot: MediaSlot
): Promise<MediaResult<{ slot: MediaSlot }>> {
  const column = SLOT_COLUMN[slot];
  const detail = await prisma.stoneDetail.findUnique({
    where: { inventoryItemId: itemId },
    select: { [column]: true } as Record<string, true>
  });
  if (!detail) return { ok: false, status: 404, error: "Item not found" };
  const path = detail[column] as string | null | undefined;

  await prisma.stoneDetail.update({
    where: { inventoryItemId: itemId },
    data: { [column]: null }
  });
  if (path && isStorageConfigured()) {
    deleteObject(path).catch((err) => console.warn("[ims/media] delete failed", err));
  }
  return { ok: true, data: { slot } };
}
