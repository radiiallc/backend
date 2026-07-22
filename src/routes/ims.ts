import { Router, type Request, type Response } from "express";

import {
  ImsCreateDocumentSchema,
  ImsCreateInventoryItemSchema,
  ImsCreateVocabularySchema,
  ImsDocumentIdsSchema,
  ImsDocumentQuerySchema,
  ImsInventoryQuerySchema,
  ImsRecordReturnSchema,
  ImsReserveItemSchema,
  ImsUpdateInventoryItemSchema
} from "@/contract";

import { requireAdmin } from "../middleware/auth";
import { getDocumentByIdFromDb, listDocumentsFromDb } from "../modules/ims/documents.reads";
import {
  createOutboundDocument,
  emailDocuments,
  quickbooksSyncDocuments,
  recordMemoReturn
} from "../modules/ims/documents.service";
import {
  createInventoryItem,
  releaseItem,
  reserveItem,
  updateInventoryItem
} from "../modules/ims/inventory.service";
import {
  getInventoryItemByIdFromDb,
  getVendorByIdFromDb,
  listInventoryFromDb,
  listVendorsFromDb,
  listVocabularyFromDb
} from "../modules/ims/reads";
import { addVocabularyValue } from "../modules/ims/vocabulary.service";

export const imsRouter = Router();

// The in-house IMS is staff-only. There is no STAFF role post-rollback, so the
// back-office is gated by ADMIN (401 unauth / 403 non-admin), same as the portal
// admin surfaces.
imsRouter.use(requireAdmin);

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ims] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

// ── Inventory ─────────────────────────────────────────────────────────────────
imsRouter.get(
  "/inventory",
  wrap(async (req, res) => {
    const parsed = ImsInventoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query params" });
      return;
    }
    res.json(await listInventoryFromDb(parsed.data));
  })
);

imsRouter.get(
  "/inventory/:id",
  wrap(async (req, res) => {
    const item = await getInventoryItemByIdFromDb(req.params.id);
    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }
    res.json(item);
  })
);

// Manually add one inventory item (+ its single detail group). The SKU is
// auto-minted; the item enters IN_STOCK. Inbound docs (Bill In / Memo In) are a
// separate, later path — this is the admin's "New inventory item".
imsRouter.post(
  "/inventory",
  wrap(async (req, res) => {
    const parsed = ImsCreateInventoryItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid inventory payload" });
      return;
    }
    const result = await createInventoryItem(parsed.data);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.item);
  })
);

// Edit an item's core + own-type detail fields. Status and itemType are not
// patchable here (status moves only through documents / reserve-release).
imsRouter.patch(
  "/inventory/:id",
  wrap(async (req, res) => {
    const parsed = ImsUpdateInventoryItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid inventory payload" });
      return;
    }
    const result = await updateInventoryItem(req.params.id, parsed.data);
    if (!result.ok) {
      const code = result.error === "Inventory item not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.item);
  })
);

// Reserve an in-stock item as a hold for a client; release clears the hold. The
// one non-document status move (IN_STOCK ↔ RESERVED), each audited.
imsRouter.post(
  "/inventory/:id/reserve",
  wrap(async (req, res) => {
    const parsed = ImsReserveItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid reserve payload" });
      return;
    }
    const result = await reserveItem(req.params.id, parsed.data.clientId, req.user!.id);
    if (!result.ok) {
      const code = result.error === "Inventory item not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.item);
  })
);

imsRouter.post(
  "/inventory/:id/release",
  wrap(async (req, res) => {
    const result = await releaseItem(req.params.id, req.user!.id);
    if (!result.ok) {
      const code = result.error === "Inventory item not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.item);
  })
);

// ── Vendors ───────────────────────────────────────────────────────────────────
imsRouter.get("/vendors", wrap(async (_req, res) => res.json(await listVendorsFromDb())));

imsRouter.get(
  "/vendors/:id",
  wrap(async (req, res) => {
    const vendor = await getVendorByIdFromDb(req.params.id);
    if (!vendor) {
      res.status(404).json({ error: "Vendor not found" });
      return;
    }
    res.json(vendor);
  })
);

// ── Vocabulary ────────────────────────────────────────────────────────────────
imsRouter.get(
  "/vocabulary",
  wrap(async (req, res) => {
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json(await listVocabularyFromDb(kind));
  })
);

// Add (or reuse) a value in a self-growing list. 201 on a fresh insert, 200 when
// an existing value (case-insensitive) is reused (admin pick-or-add).
imsRouter.post(
  "/vocabulary",
  wrap(async (req, res) => {
    const parsed = ImsCreateVocabularySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid vocabulary payload" });
      return;
    }
    const result = await addVocabularyValue(parsed.data.kind, parsed.data.value);
    res.status(result.created ? 201 : 200).json(result.value);
  })
);

// ── Documents ─────────────────────────────────────────────────────────────────
imsRouter.get(
  "/documents",
  wrap(async (req, res) => {
    const parsed = ImsDocumentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query params" });
      return;
    }
    res.json(await listDocumentsFromDb(parsed.data));
  })
);

imsRouter.get(
  "/documents/:id",
  wrap(async (req, res) => {
    const doc = await getDocumentByIdFromDb(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  })
);

// Create an outbound Memo Out / Invoice from existing inventory, transitioning
// each line's item (ON_MEMO / SOLD) and minting the document number. The
// creating admin comes from the session (requireAdmin guarantees req.user).
imsRouter.post(
  "/documents",
  wrap(async (req, res) => {
    const parsed = ImsCreateDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document payload" });
      return;
    }
    const result = await createOutboundDocument(parsed.data, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.document);
  })
);

// Stamp emailedAt = now on a batch of docs (admin sendEmail). Static path, so
// it must precede the "/documents/:id/*" param routes below.
imsRouter.post(
  "/documents/email",
  wrap(async (req, res) => {
    const parsed = ImsDocumentIdsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    const result = await emailDocuments(parsed.data.documentIds);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ documents: result.documents });
  })
);

// Stamp quickbooksSyncedAt = now on a batch of INVOICE/BILL_IN docs (admin
// _runSync). Status is left unchanged — see documents.service note.
imsRouter.post(
  "/documents/quickbooks-sync",
  wrap(async (req, res) => {
    const parsed = ImsDocumentIdsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    const result = await quickbooksSyncDocuments(parsed.data.documentIds);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ documents: result.documents });
  })
);

// Record a return against a Memo Out — creates a linked RETURN_MEMO_OUT, sends
// the returned stones back to IN_STOCK, and auto-closes the memo if nothing is
// left out. Returns both the new return doc and the updated memo.
imsRouter.post(
  "/documents/:id/return",
  wrap(async (req, res) => {
    const parsed = ImsRecordReturnSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid return payload" });
      return;
    }
    const result = await recordMemoReturn(req.params.id, parsed.data, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({ returnDocument: result.returnDocument, memo: result.memo });
  })
);
