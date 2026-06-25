import { prisma, Prisma } from "@/db";
import type {
  CreateInboundDocumentBody,
  DocumentMutationResult,
  InboundDocumentTypeValue,
  InboundLineInput,
  VoidDocumentResult
} from "@/contract";

import {
  jewelryCreateData,
  otherCreateData,
  stoneCreateData
} from "./inventory.service";
import { nextSku } from "./sku";

// ────────────────────────────────────────────────────────────────────────────
// Document engine (§H4.1). The shared transactional core every document type
// builds on. H4 implements the three INBOUND types, which CREATE the inventory
// items they list (spec §4.4): on creation the system creates each item record,
// sets it IN_STOCK, auto-generates a SKU when absent, and logs the change in
// item_status_history — all in one transaction so a failure leaves no orphans
// and burns no SKU (gate §6.15: status only ever changes through a document).
//
// Per-type rules (spec §6.1):
//   BILL_IN            — purchase from a vendor; items → IN_STOCK;
//                        OPEN → EXPORTED|VOID; may link an open PO → BILLED (§6.4)
//   MEMO_IN            — consignment from a vendor; items → IN_STOCK;
//                        OPEN → CLOSED|VOID; requires a due date
//   BRAND_INVENTORY_IN — client brand items entering our care; items → IN_STOCK;
//                        OPEN|VOID; sets brandOwnerId = the client on each item
//
// Inbound documents carry the vendor's OWN number in externalReference;
// documentNumber stays null (Jennifer 2026-06-23 — "not ours to assign").
// ────────────────────────────────────────────────────────────────────────────

type PartyKind = "vendor" | "client";

const INBOUND_CONFIG: Record<
  InboundDocumentTypeValue,
  { party: PartyKind; requiresDueDate: boolean; label: string }
> = {
  BILL_IN: { party: "vendor", requiresDueDate: false, label: "Bill In" },
  MEMO_IN: { party: "vendor", requiresDueDate: true, label: "Memo In" },
  BRAND_INVENTORY_IN: { party: "client", requiresDueDate: false, label: "Brand Inventory In" }
};

// Thrown for caller-fixable problems (bad party, missing due date, stale PO) so
// the route can surface a friendly 400 instead of a 500.
class DocumentValidationError extends Error {}

// Build the InventoryItem create payload for one inbound line. status is forced
// IN_STOCK; vendor (Bill/Memo In) or brandOwner (Brand Inv In) comes from the
// header; the detail block must match itemType (others are ignored, as in H3).
function buildItemCreate(
  line: InboundLineInput,
  sku: string,
  documentId: string,
  actingUserId: string,
  historyNote: string,
  party: { vendorId?: string; brandOwnerId?: string }
): Prisma.InventoryItemCreateInput {
  const itemSubtype = line.itemType === "STONE" ? line.itemSubtype ?? null : null;

  const data: Prisma.InventoryItemCreateInput = {
    sku,
    itemType: line.itemType,
    itemSubtype,
    status: "IN_STOCK",
    // Default OFF — nothing leaks to the portal until explicitly enabled (gate §6.17).
    visibleOnPortal: line.visibleOnPortal ?? false,
    ...(party.vendorId ? { vendor: { connect: { id: party.vendorId } } } : {}),
    ...(party.brandOwnerId ? { brandOwner: { connect: { id: party.brandOwnerId } } } : {}),
    statusHistory: {
      create: {
        previousStatus: null,
        newStatus: "IN_STOCK",
        documentId,
        changedById: actingUserId,
        notes: historyNote
      }
    }
  };

  if (line.itemType === "STONE" && line.stone) {
    data.stoneDetail = { create: stoneCreateData(line.stone) };
  } else if (line.itemType === "JEWELRY" && line.jewelry) {
    data.jewelryDetail = { create: jewelryCreateData(line.jewelry) };
  } else if (line.itemType === "OTHER_MATERIAL" && line.other) {
    data.otherMaterialDetail = { create: otherCreateData(line.other) };
  }

  return data;
}

export async function createInboundDocument(
  body: CreateInboundDocumentBody,
  actingUserId: string
): Promise<DocumentMutationResult> {
  const config = INBOUND_CONFIG[body.type];

  // ── Pre-flight validation (party + due date) ──
  let vendorId: string | undefined;
  let clientId: string | undefined;
  if (config.party === "vendor") {
    if (!body.vendorId) {
      return { ok: false, error: `A vendor is required for a ${config.label}.` };
    }
    vendorId = body.vendorId;
  } else {
    if (!body.clientId) {
      return { ok: false, error: `A brand-owner client is required for a ${config.label}.` };
    }
    clientId = body.clientId;
  }
  if (config.requiresDueDate && !body.dueDate) {
    return { ok: false, error: `A due date is required for a ${config.label}.` };
  }

  const itemVendorId = config.party === "vendor" ? vendorId : undefined;
  const itemBrandOwnerId = config.party === "client" ? clientId : undefined;
  const historyNote = `Received via ${config.label}.`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Bill In may link an existing open PO (§6.4). Validate before creating
      // anything so we fail fast with a clear message.
      if (body.linkedPoId) {
        if (body.type !== "BILL_IN") {
          throw new DocumentValidationError("Only a Bill In can be linked to a purchase order.");
        }
        const po = await tx.document.findUnique({
          where: { id: body.linkedPoId },
          select: { id: true, type: true, status: true }
        });
        if (!po || po.type !== "PURCHASE_ORDER") {
          throw new DocumentValidationError("Linked purchase order not found.");
        }
        if (po.status !== "OPEN") {
          throw new DocumentValidationError("That purchase order is not open and cannot be billed.");
        }
      }

      const doc = await tx.document.create({
        data: {
          type: body.type,
          documentNumber: null, // inbound → vendor's own number in externalReference
          externalReference: body.externalReference ?? null,
          status: "OPEN",
          ...(vendorId ? { vendor: { connect: { id: vendorId } } } : {}),
          ...(clientId ? { client: { connect: { id: clientId } } } : {}),
          ...(body.issueDate ? { issueDate: new Date(body.issueDate) } : {}),
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          projectJob: body.projectJob ?? null,
          discountAmount: body.discountAmount ?? null,
          notes: body.notes ?? null,
          ...(body.type === "BILL_IN" && body.linkedPoId
            ? { billedPo: { connect: { id: body.linkedPoId } } }
            : {}),
          createdBy: { connect: { id: actingUserId } }
        },
        select: { id: true }
      });

      const createdItemIds: string[] = [];
      for (const line of body.lines) {
        const sku = line.sku ?? (await nextSku(tx));
        const item = await tx.inventoryItem.create({
          data: buildItemCreate(line, sku, doc.id, actingUserId, historyNote, {
            vendorId: itemVendorId,
            brandOwnerId: itemBrandOwnerId
          }),
          select: { id: true }
        });
        createdItemIds.push(item.id);

        await tx.documentLineItem.create({
          data: {
            documentId: doc.id,
            inventoryItemId: item.id,
            lineStatus: "IN_STOCK",
            quantity: line.quantity ?? null,
            caratWeight: line.caratWeight ?? null,
            unitPrice: line.unitPrice ?? null,
            totalPrice: line.totalPrice ?? null,
            discountAmount: line.discountAmount ?? null,
            notes: line.notes ?? null
          }
        });
      }

      // Mark the linked PO billed once the bill is fully recorded (§6.4).
      if (body.type === "BILL_IN" && body.linkedPoId) {
        await tx.document.update({
          where: { id: body.linkedPoId },
          data: { status: "BILLED" }
        });
      }

      return { id: doc.id, createdItemIds };
    });

    return {
      ok: true,
      id: result.id,
      documentNumber: null,
      createdItemIds: result.createdItemIds
    };
  } catch (err) {
    if (err instanceof DocumentValidationError) {
      return { ok: false, error: err.message };
    }
    return mapDocError(err);
  }
}

// ── Void ───────────────────────────────────────────────────────────────────
// Voiding restores affected item statuses (spec §11.3). For an INBOUND document
// the items were CREATED by it, so "restore" means removing them from stock —
// the receipt is reversed and the items never really came in. Guarded:
//   • every line item must still be IN_STOCK (untouched by a later movement), and
//   • no OTHER document may reference any of them.
// If either guard fails we refuse (naming the SKUs) rather than silently
// clobbering a downstream document's state. The document itself is retained with
// status VOID as the audit record; its lines + the items it created are deleted
// (their detail + status-history cascade). Outbound void (status restore in
// place) lands with the outbound types in H6.
export async function voidDocument(
  id: string,
  actingUserId: string
): Promise<VoidDocumentResult> {
  void actingUserId; // reserved for the outbound restore-history path (H6)

  const doc = await prisma.document.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      status: true,
      lineItems: {
        select: { id: true, inventoryItemId: true, inventoryItem: { select: { sku: true, status: true } } }
      }
    }
  });
  if (!doc) return { ok: false, error: "Document not found" };
  if (doc.status === "VOID") return { ok: false, error: "Document is already void." };

  const INBOUND: ReadonlyArray<string> = ["BILL_IN", "MEMO_IN", "BRAND_INVENTORY_IN"];
  if (!INBOUND.includes(doc.type)) {
    return {
      ok: false,
      error: "Voiding this document type is implemented in a later milestone (H6/H7)."
    };
  }

  const itemIds = doc.lineItems.map((l) => l.inventoryItemId);

  // Guard 1: every created item must still be IN_STOCK.
  const moved = doc.lineItems.filter((l) => l.inventoryItem.status !== "IN_STOCK");
  if (moved.length > 0) {
    const skus = moved.map((l) => l.inventoryItem.sku).join(", ");
    return {
      ok: false,
      error: `Cannot void: ${skus} ${moved.length === 1 ? "has" : "have"} already moved out of stock.`
    };
  }

  // Guard 2: no other document may reference these items.
  const otherLines = itemIds.length
    ? await prisma.documentLineItem.findMany({
        where: { inventoryItemId: { in: itemIds }, documentId: { not: id } },
        select: { inventoryItem: { select: { sku: true } } }
      })
    : [];
  if (otherLines.length > 0) {
    const skus = Array.from(new Set(otherLines.map((l) => l.inventoryItem.sku))).join(", ");
    return {
      ok: false,
      error: `Cannot void: ${skus} ${otherLines.length === 1 ? "is" : "are"} referenced by another document.`
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Delete this doc's lines first (they FK-restrict item deletion), then the
      // items (detail + status history cascade), then mark the doc VOID.
      await tx.documentLineItem.deleteMany({ where: { documentId: id } });
      if (itemIds.length) {
        await tx.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
      }
      await tx.document.update({ where: { id }, data: { status: "VOID" } });
    });
    return { ok: true, id };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[ims] document void failed", err);
    return { ok: false, error: "Internal error" };
  }
}

function mapDocError(err: unknown): DocumentMutationResult {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return { ok: false, error: "That SKU is already in use." };
    if (err.code === "P2025" || err.code === "P2003") {
      return { ok: false, error: "A referenced vendor, client, or document does not exist." };
    }
  }
  // eslint-disable-next-line no-console
  console.error("[ims] inbound document create failed", err);
  return { ok: false, error: "Internal error" };
}
