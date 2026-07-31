import { Prisma, prisma } from "@/db";
import type {
  Request as PrismaRequest,
  RequestItem as PrismaRequestItem,
  User as PrismaUser
} from "@/db";
import { formatRequestReference } from "@/domain";
import type { AdminActionResult, AdminRequest, ImsDocument } from "@/contract";

import { sendRequestReviewSummaryEmail, type RequestReviewItem } from "../../integrations/email";
import { DOC_PREFIX, NEW_ITEM_STATUS, NEW_LINE_STATUS } from "../ims/documents.constants";
import { IMS_DOC_INCLUDE, prismaDocToDto } from "../ims/documents.mappers";
import { mintSkuBatch } from "../ims/inventory.service";
import { prismaRequestToAdminRequest } from "./mappers";

// Requests read include used by the action services so the returned AdminRequest
// carries the same fields the read endpoints do (converted-doc number etc.).
const REQUEST_ADMIN_INCLUDE = {
  items: true,
  convertedDocument: { select: { documentNumber: true } }
} as const;

type RequestWithItemsUser = PrismaRequest & { items: PrismaRequestItem[]; user: PrismaUser };

// Overall request status derived from its items' individual decisions. Shared by
// completeReview, decline, and convert so the three never disagree.
function deriveOverall(
  items: PrismaRequestItem[]
): "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED" {
  const approved = items.filter((i) => i.status === "APPROVED").length;
  const rejected = items.filter((i) => i.status === "REJECTED").length;
  if (approved === items.length) return "APPROVED";
  if (rejected === items.length) return "REJECTED";
  return "PARTIALLY_APPROVED";
}

// Build the per-item review lines + send the outcome email. Fail-loud-but-non-
// blocking (Gate §7): the review status is already committed by the caller, so a
// send failure returns a warning string rather than throwing. Shared by
// completeReview / declineRequest / convertRequestToDocument.
async function sendReviewOutcomeEmail(
  request: RequestWithItemsUser,
  overall: "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED"
): Promise<string | undefined> {
  const summaryItems: RequestReviewItem[] = request.items.map((it) => {
    const payload = (it.snapshotPayload ?? {}) as Record<string, unknown>;
    const variety =
      (typeof payload.variety === "string" && payload.variety) ||
      (typeof payload.varietyRaw === "string" && payload.varietyRaw) ||
      it.snapshotSku;
    const shape =
      (typeof payload.shape === "string" && payload.shape) ||
      (typeof payload.shapeRaw === "string" && payload.shapeRaw) ||
      null;
    const weightCtRaw =
      typeof payload.weightCt === "number"
        ? payload.weightCt
        : typeof payload.carat === "number"
          ? payload.carat
          : null;
    return {
      sku: it.snapshotSku,
      varietyOrName: variety as string,
      shape,
      weightCt: weightCtRaw,
      outcome: it.status === "APPROVED" ? "APPROVED" : "REJECTED",
      totalPriceUsd: Number(it.snapshotPriceUsd.toString())
    };
  });

  try {
    const firstName = request.user.fullName.trim().split(/\s+/)[0] ?? request.user.fullName;
    await sendRequestReviewSummaryEmail({
      email: request.user.email,
      firstName,
      reference: formatRequestReference(request.seq),
      type: request.type,
      overallStatus: overall,
      items: summaryItems,
      externalNote: request.externalNote ?? ""
    });
    return undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("[requests] review summary email failed", err);
    return (
      `Review completed, but the outcome email to ${request.user.email} could not be sent: ${detail}. ` +
      `Verify your RESEND_API_KEY and that the RESEND_FROM_EMAIL domain is verified in Resend.`
    );
  }
}

// Port of the portal admin request actions. requireAdmin() + revalidatePath are
// handled at the route layer; item status transitions, the overall-status
// derivation, the pending-items guard, and the review-summary email are
// unchanged.

export async function approveRequestItem(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "APPROVED" },
    include: { request: true }
  });
  return { ok: true };
}

export async function rejectRequestItem(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "REJECTED" },
    include: { request: true }
  });
  return { ok: true };
}

export async function setRequestItemPending(itemId: string): Promise<AdminActionResult> {
  if (!itemId) return { ok: false, error: "Missing itemId" };
  await prisma.requestItem.update({
    where: { id: itemId },
    data: { status: "PENDING" }
  });
  return { ok: true };
}

export async function updateRequestExternalNote(
  requestId: string,
  externalNote: string
): Promise<AdminActionResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };
  await prisma.request.update({
    where: { id: requestId },
    data: { externalNote: externalNote ?? "" }
  });
  return { ok: true };
}

export async function completeRequestReview(requestId: string): Promise<AdminActionResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  if (!request) return { ok: false, error: "Request not found" };

  const pendingCount = request.items.filter((i) => i.status === "PENDING").length;
  if (pendingCount > 0) {
    return {
      ok: false,
      error: `Cannot complete review while ${pendingCount} item${pendingCount === 1 ? "" : "s"} still pending.`
    };
  }

  const overall = deriveOverall(request.items);

  await prisma.request.update({
    where: { id: requestId },
    data: { status: overall, reviewedAt: new Date() }
  });

  const warning = await sendReviewOutcomeEmail(request, overall);
  return warning ? { ok: true, warning } : { ok: true };
}

// ── H9 #0036 — Decline & close ───────────────────────────────────────────────
// The exit for a request where nothing is going out: deny every remaining item
// and finalize the review (→ REJECTED, reviewedAt, outcome email). Touches NO
// inventory — declining is communication/record only. Refuses if any line is
// approved (that request should mint a Memo/Invoice via convert instead).
export async function declineRequest(requestId: string): Promise<AdminActionResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.convertedDocumentId) {
    return { ok: false, error: "This request has already been converted to a document." };
  }
  if (request.items.some((i) => i.status === "APPROVED")) {
    return {
      ok: false,
      error: "This request has approved items — create the Memo / Invoice instead of declining."
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.requestItem.updateMany({
      where: { requestId, status: "PENDING" },
      data: { status: "REJECTED" }
    });
    await tx.request.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedAt: new Date() }
    });
  });

  // Re-read so the outcome email reflects the now-all-rejected items.
  const finalized = await prisma.request.findUniqueOrThrow({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  const warning = await sendReviewOutcomeEmail(finalized, "REJECTED");
  return warning ? { ok: true, warning } : { ok: true };
}

// ── H9 #0038 — substitute stones ─────────────────────────────────────────────
// Add owned inventory items to a request as dealer-offered substitutes (auto-
// APPROVED, flagged via substituteInventoryItemId). Only IN_STOCK / RESERVED
// items are addable, and never one already on the request. Each new line
// snapshots the item's wholesale value (mirrors the mock's twOf), so convert can
// price it without re-reading the item.
export type SubstituteResult =
  | { ok: true; request: AdminRequest }
  | { ok: false; error: string };

function wholesaleTotalOf(item: {
  stone: { weightCt: Prisma.Decimal; wholesalePricePerCt: Prisma.Decimal | null; totalWholesalePrice: Prisma.Decimal | null } | null;
  jewelry: { wholesalePrice: Prisma.Decimal | null } | null;
  material: { wholesalePrice: Prisma.Decimal | null } | null;
}): number {
  const num = (d: Prisma.Decimal | null): number | null =>
    d === null || d === undefined ? null : Number(d.toString());
  if (item.stone) {
    const ct = num(item.stone.weightCt);
    const ppc = num(item.stone.wholesalePricePerCt);
    const total = ct !== null && ppc !== null ? Math.round(ct * ppc * 100) / 100 : num(item.stone.totalWholesalePrice);
    return total ?? 0;
  }
  if (item.jewelry) return num(item.jewelry.wholesalePrice) ?? 0;
  if (item.material) return num(item.material.wholesalePrice) ?? 0;
  return 0;
}

export async function addSubstituteItems(
  requestId: string,
  inventoryItemIds: string[]
): Promise<SubstituteResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };
  const ids = Array.from(new Set((inventoryItemIds ?? []).filter(Boolean)));
  if (ids.length === 0) return { ok: false, error: "No stones selected" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { items: true }
  });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.convertedDocumentId) return { ok: false, error: "This request is closed." };

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: ids } },
    include: { stone: true, jewelry: true, material: true }
  });
  if (items.length !== ids.length) {
    const found = new Set(items.map((i) => i.id));
    const missing = ids.filter((id) => !found.has(id));
    return { ok: false, error: `Inventory item(s) not found: ${missing.join(", ")}` };
  }
  const notAddable = items.filter((i) => i.status !== "IN_STOCK" && i.status !== "RESERVED");
  if (notAddable.length > 0) {
    return {
      ok: false,
      error: `Only in-stock stones can be offered: ${notAddable.map((i) => i.sku).join(", ")}`
    };
  }
  const already = new Set(request.items.map((i) => i.substituteInventoryItemId).filter(Boolean));
  const fresh = items.filter((i) => !already.has(i.id));
  if (fresh.length === 0) return { ok: false, error: "Those stones are already on this request." };

  await prisma.requestItem.createMany({
    data: fresh.map((item) => ({
      requestId,
      gemstoneId: null,
      snapshotSku: item.sku,
      snapshotPriceUsd: wholesaleTotalOf(item),
      status: "APPROVED" as const,
      substituteInventoryItemId: item.id,
      snapshotPayload: {
        category: item.itemType === "STONE" ? (item.stone?.gemType === "Diamond" ? "diamond" : "gemstone") : "gemstone",
        vendor: "RADIIA stock",
        addedByDealer: true,
        sku: item.sku,
        varietyRaw: item.stone?.gemType ?? item.itemName ?? item.sku,
        shapeRaw: item.stone?.shape ?? null,
        colorRaw: item.stone?.color ?? null,
        clarity: item.stone?.clarity ?? null,
        weightCt: item.stone ? Number(item.stone.weightCt.toString()) : null,
        certLab: item.stone?.lab ?? null,
        certNumber: item.stone?.certNumber ?? null,
        origin: item.stone?.origin ?? null,
        treatment: item.stone?.treatment ?? null
      }
    }))
  });

  const updated = await prisma.request.findUniqueOrThrow({
    where: { id: requestId },
    include: REQUEST_ADMIN_INCLUDE
  });
  return { ok: true, request: prismaRequestToAdminRequest(updated) };
}

// Remove a dealer-added substitute line. Client-requested lines can never be
// removed (only approved/denied); the guard enforces that via the substitute FK.
export async function removeSubstituteItem(requestItemId: string): Promise<SubstituteResult> {
  if (!requestItemId) return { ok: false, error: "Missing requestItemId" };
  const item = await prisma.requestItem.findUnique({
    where: { id: requestItemId },
    include: { request: { select: { convertedDocumentId: true } } }
  });
  if (!item) return { ok: false, error: "Request item not found" };
  if (!item.substituteInventoryItemId) {
    return { ok: false, error: "Only a dealer-added substitute can be removed." };
  }
  if (item.request.convertedDocumentId) return { ok: false, error: "This request is closed." };

  await prisma.requestItem.delete({ where: { id: requestItemId } });

  const updated = await prisma.request.findUniqueOrThrow({
    where: { id: item.requestId },
    include: REQUEST_ADMIN_INCLUDE
  });
  return { ok: true, request: prismaRequestToAdminRequest(updated) };
}

// ── H9 #0035 — convert an approved request into a Memo Out / Invoice ──────────
// Option A (auto-receive on convert): the terminal action for a request with at
// least one approved item. It is the SINGLE "send review & create doc" action —
// any still-pending line is denied (it isn't going out), the client gets the
// outcome email, and the approved lines become a real MEMO_OUT / INVOICE.
//
// Each approved line becomes a document line backed by an owned InventoryItem:
//   • a client-requested (feed) line JIT-receives a fresh STONE item from its
//     snapshot (born IN_STOCK, then drawn onto the doc → ON_MEMO / SOLD). Real
//     cost/ownership live in QuickBooks; the line price is the client-agreed
//     snapshot total.
//   • a substitute line draws down the owned item it already points at.
// Every drawn item gets an ItemStatusHistory row pointing at the new doc, exactly
// like the outbound create path.
export type ConvertRequestResult =
  | { ok: true; document: ImsDocument; request: AdminRequest; warning?: string }
  | { ok: false; error: string };

export async function convertRequestToDocument(
  requestId: string,
  createdById: string
): Promise<ConvertRequestResult> {
  if (!requestId) return { ok: false, error: "Missing requestId" };

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.convertedDocumentId) {
    return { ok: false, error: "This request has already been converted to a document." };
  }

  const approved = request.items.filter((i) => i.status === "APPROVED");
  if (approved.length === 0) {
    return { ok: false, error: "Approve at least one item before creating a document." };
  }

  const type = request.type === "MEMO" ? "MEMO_OUT" : "INVOICE";
  const newItemStatus = NEW_ITEM_STATUS[type];
  const newLineStatus = NEW_LINE_STATUS[type];

  // Validate substitute items up front (must still be drawable).
  const substituteIds = approved
    .map((i) => i.substituteInventoryItemId)
    .filter((v): v is string => v !== null);
  const substituteItems = substituteIds.length
    ? await prisma.inventoryItem.findMany({
        where: { id: { in: substituteIds } },
        include: { stone: true, jewelry: true, material: true }
      })
    : [];
  const subById = new Map(substituteItems.map((i) => [i.id, i]));
  for (const id of substituteIds) {
    const it = subById.get(id);
    if (!it) return { ok: false, error: `Substitute item not found: ${id}` };
    if (it.status !== "IN_STOCK" && it.status !== "RESERVED") {
      return { ok: false, error: `Substitute ${it.sku} is no longer available (${it.status}).` };
    }
  }

  const num = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const now = new Date();

  const docId = await prisma.$transaction(async (tx) => {
    // Batch-mint SKUs for the feed lines that need a fresh inventory item.
    const feedApproved = approved.filter((i) => i.substituteInventoryItemId === null);
    const skus = await mintSkuBatch(tx, feedApproved.length);

    // Build the (inventoryItemId, price, sourceStatus) for every approved line.
    type Line = {
      inventoryItemId: string;
      previousStatus: "IN_STOCK" | "RESERVED";
      quantity: number | null;
      caratWeight: number | null;
      unitPrice: number | null;
      totalPrice: number | null;
    };
    const lines: Line[] = [];

    // 1) JIT-receive each feed line as a fresh STONE, then draw it onto the doc.
    let skuIdx = 0;
    for (const ri of feedApproved) {
      const payload = (ri.snapshotPayload ?? {}) as Record<string, unknown>;
      const str = (k: string): string | null =>
        typeof payload[k] === "string" && (payload[k] as string).trim() !== "" ? (payload[k] as string) : null;
      const nOf = (k: string): number | null =>
        typeof payload[k] === "number" && Number.isFinite(payload[k] as number) ? (payload[k] as number) : null;
      const category = str("category");
      const weightCt = nOf("weightCt") ?? 0;
      const total = Number(ri.snapshotPriceUsd.toString());
      const qty = nOf("qty");
      const perCt = nOf("displayPricePerCtUsd") ?? (weightCt > 0 ? Math.round((total / weightCt) * 100) / 100 : null);
      const originStr = str("origin");
      const created = await tx.inventoryItem.create({
        data: {
          sku: skus[skuIdx++],
          itemType: "STONE",
          itemSubtype: "SINGLE",
          vendorId: null,
          vendorSku: ri.snapshotSku,
          itemName: str("varietyRaw"),
          visibleOnPortal: false,
          notes: `Received to fulfill request ${formatRequestReference(request.seq)}`,
          stone: {
            create: {
              gemType: category === "diamond" ? "Diamond" : str("varietyRaw"),
              naturalOrLab:
                category === "diamond"
                  ? originStr === "Lab"
                    ? "LAB"
                    : originStr === "Natural"
                      ? "NATURAL"
                      : null
                  : null,
              shape: str("shapeRaw") ?? str("shapeMapped") ?? "—",
              weightCt,
              quantity: qty,
              color: str("colorRaw"),
              clarity: str("clarity"),
              lab: str("certLab"),
              certNumber: str("certNumber"),
              origin: originStr,
              treatment: str("treatment"),
              wholesalePricePerCt: perCt,
              totalWholesalePrice: total
            }
          }
        }
      });
      lines.push({
        inventoryItemId: created.id,
        previousStatus: "IN_STOCK",
        quantity: qty,
        caratWeight: weightCt || null,
        unitPrice: perCt,
        totalPrice: total
      });
    }

    // 2) Draw each substitute line down from the owned item it points at.
    for (const ri of approved) {
      if (ri.substituteInventoryItemId === null) continue;
      const item = subById.get(ri.substituteInventoryItemId)!;
      const total = wholesaleTotalOf(item);
      lines.push({
        inventoryItemId: item.id,
        previousStatus: item.status === "RESERVED" ? "RESERVED" : "IN_STOCK",
        quantity: item.stone?.quantity ?? item.jewelry?.quantity ?? item.material?.quantity ?? null,
        caratWeight: item.stone ? num(Number(item.stone.weightCt.toString())) : null,
        unitPrice: item.stone ? num(item.stone.wholesalePricePerCt ? Number(item.stone.wholesalePricePerCt.toString()) : null) : null,
        totalPrice: total
      });
    }

    // Mint the document number and create the doc with all lines.
    const seq = await tx.documentSequence.upsert({
      where: { type },
      create: { type, lastValue: 1001 },
      update: { lastValue: { increment: 1 } }
    });
    const documentNumber = `${DOC_PREFIX[type]}-${seq.lastValue}`;
    const doc = await tx.document.create({
      data: {
        type,
        documentNumber,
        status: "OPEN",
        clientId: request.companyId,
        issueDate: now,
        createdById,
        lineItems: {
          create: lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            lineStatus: newLineStatus,
            quantity: l.quantity,
            caratWeight: l.caratWeight,
            unitPrice: l.unitPrice,
            totalPrice: l.totalPrice
          }))
        }
      }
    });

    // Transition every drawn item + audit each move against this doc.
    for (const l of lines) {
      await tx.inventoryItem.update({
        where: { id: l.inventoryItemId },
        data: {
          status: newItemStatus,
          visibleOnPortal: false,
          reservedForClientId: null,
          reservedAt: null
        }
      });
      await tx.itemStatusHistory.create({
        data: {
          inventoryItemId: l.inventoryItemId,
          previousStatus: l.previousStatus,
          newStatus: newItemStatus,
          documentId: doc.id,
          changedById: createdById
        }
      });
    }

    // Any still-pending line wasn't approved → deny it. Then finalize the review
    // and link the request to its new document.
    await tx.requestItem.updateMany({
      where: { requestId, status: "PENDING" },
      data: { status: "REJECTED" }
    });
    return doc.id;
  });

  // Reload request (post-deny) to derive the overall outcome + email it.
  const finalized = await prisma.request.findUniqueOrThrow({
    where: { id: requestId },
    include: { items: true, user: true }
  });
  const overall = deriveOverall(finalized.items);
  await prisma.request.update({
    where: { id: requestId },
    data: { status: overall, reviewedAt: now, convertedDocumentId: docId }
  });

  const warning = await sendReviewOutcomeEmail(finalized, overall);

  const createdDoc = await prisma.document.findUniqueOrThrow({
    where: { id: docId },
    include: IMS_DOC_INCLUDE
  });
  const updatedRequest = await prisma.request.findUniqueOrThrow({
    where: { id: requestId },
    include: REQUEST_ADMIN_INCLUDE
  });

  return {
    ok: true,
    document: prismaDocToDto(createdDoc),
    request: prismaRequestToAdminRequest(updatedRequest),
    ...(warning ? { warning } : {})
  };
}
