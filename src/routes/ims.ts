import { Router, type Request, type Response } from "express";

import { ImsCreateDocumentSchema, ImsDocumentQuerySchema, ImsInventoryQuerySchema } from "@/contract";

import { requireAdmin } from "../middleware/auth";
import { getDocumentByIdFromDb, listDocumentsFromDb } from "../modules/ims/documents.reads";
import { createOutboundDocument } from "../modules/ims/documents.service";
import {
  getInventoryItemByIdFromDb,
  getVendorByIdFromDb,
  listInventoryFromDb,
  listVendorsFromDb,
  listVocabularyFromDb
} from "../modules/ims/reads";

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
