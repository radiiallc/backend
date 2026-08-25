import { Router, type Request, type Response } from "express";

import {
  ImsAdjustParcelRemainingSchema,
  ImsClientLifecycleSchema,
  ImsClientQuerySchema,
  ImsCreateClientSchema,
  ImsCreateDocumentSchema,
  ImsCreateInboundDocumentSchema,
  ImsCreateInventoryItemSchema,
  ImsCreatePurchaseOrderSchema,
  ImsCreateVendorSchema,
  ImsCreateVocabularySchema,
  ImsDocumentIdsSchema,
  ImsDocumentQuerySchema,
  ImsEmailDocumentsSchema,
  ImsGiaLookupSchema,
  ImsInventoryQuerySchema,
  ImsParseInboundCsvSchema,
  ImsRecordReturnSchema,
  ImsReserveItemSchema,
  ImsUpdateClientSchema,
  ImsUpdateInventoryItemSchema,
  ImsUpdateVendorSchema
} from "@/contract";

import { requireAdmin } from "../middleware/auth";
import {
  createClient,
  transitionClientStatus,
  updateClient
} from "../modules/ims/clients.service";
import { buildDocumentPdf } from "../modules/ims/document-pdf";
import { getDocumentByIdFromDb, listDocumentsFromDb } from "../modules/ims/documents.reads";
import {
  createInboundDocument,
  createOutboundDocument,
  createPurchaseOrder,
  deleteDocument,
  emailDocuments,
  quickbooksSyncDocuments,
  recordMemoReturn,
  recordVendorReturn,
  voidDocument
} from "../modules/ims/documents.service";
import {
  adjustParcelRemaining,
  createInventoryItem,
  releaseItem,
  reserveItem,
  updateInventoryItem
} from "../modules/ims/inventory.service";
import {
  getClientByIdFromDb,
  getInventoryItemByIdFromDb,
  getVendorByIdFromDb,
  listClientsFromDb,
  listInventoryFromDb,
  listVendorsFromDb,
  listVocabularyFromDb
} from "../modules/ims/reads";
import { parseInventoryCsv, parseInventoryUpload } from "../modules/ims/csv-import";
import { enrichInboundCsvWithGia } from "../modules/ims/gia-enrich";
import { annotateRestocks } from "../modules/ims/restock";
import { lookupGiaReport } from "../modules/ims/gia.service";
import { createVendor, updateVendor } from "../modules/ims/vendors.service";
import { addVocabularyValue } from "../modules/ims/vocabulary.service";

export const imsRouter = Router();

imsRouter.use(requireAdmin);

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      console.error("[ims] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

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

imsRouter.patch(
  "/inventory/:id/remaining",
  wrap(async (req, res) => {
    const parsed = ImsAdjustParcelRemainingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid adjustment payload" });
      return;
    }
    const result = await adjustParcelRemaining(req.params.id, parsed.data, req.user!.id);
    if (!result.ok) {
      const code = result.error === "Inventory item not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.item);
  })
);

imsRouter.post(
  "/gia/lookup",
  wrap(async (req, res) => {
    const parsed = ImsGiaLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lookup payload" });
      return;
    }
    res.json(await lookupGiaReport(parsed.data.reportNumber));
  })
);

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

imsRouter.post(
  "/vendors",
  wrap(async (req, res) => {
    const parsed = ImsCreateVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid vendor payload" });
      return;
    }
    const result = await createVendor(parsed.data);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.vendor);
  })
);

imsRouter.patch(
  "/vendors/:id",
  wrap(async (req, res) => {
    const parsed = ImsUpdateVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid vendor payload" });
      return;
    }
    const result = await updateVendor(req.params.id, parsed.data);
    if (!result.ok) {
      const code = result.error === "Vendor not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.vendor);
  })
);

imsRouter.get(
  "/clients",
  wrap(async (req, res) => {
    const parsed = ImsClientQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query params" });
      return;
    }
    res.json(await listClientsFromDb(parsed.data));
  })
);

imsRouter.get(
  "/clients/:id",
  wrap(async (req, res) => {
    const client = await getClientByIdFromDb(req.params.id);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    res.json(client);
  })
);

imsRouter.post(
  "/clients",
  wrap(async (req, res) => {
    const parsed = ImsCreateClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid client payload" });
      return;
    }
    const result = await createClient(parsed.data);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.client);
  })
);

imsRouter.patch(
  "/clients/:id",
  wrap(async (req, res) => {
    const parsed = ImsUpdateClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid client payload" });
      return;
    }
    const result = await updateClient(req.params.id, parsed.data);
    if (!result.ok) {
      const code = result.error === "Client not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.client);
  })
);

imsRouter.post(
  "/clients/:id/status",
  wrap(async (req, res) => {
    const parsed = ImsClientLifecycleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lifecycle payload" });
      return;
    }
    const result = await transitionClientStatus(req.params.id, parsed.data.action);
    if (!result.ok) {
      const code = result.error === "Client not found" ? 404 : 400;
      res.status(code).json({ error: result.error });
      return;
    }
    res.json(result.client);
  })
);

imsRouter.get(
  "/vocabulary",
  wrap(async (req, res) => {
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json(await listVocabularyFromDb(kind));
  })
);

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

imsRouter.post(
  "/documents/purchase-order",
  wrap(async (req, res) => {
    const parsed = ImsCreatePurchaseOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid purchase order payload" });
      return;
    }
    const result = await createPurchaseOrder(parsed.data, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.document);
  })
);

imsRouter.post(
  "/documents/inbound",
  wrap(async (req, res) => {
    const parsed = ImsCreateInboundDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid inbound document payload" });
      return;
    }
    const result = await createInboundDocument(parsed.data, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.document);
  })
);

imsRouter.post(
  "/documents/inbound/parse-csv",
  wrap(async (req, res) => {
    const parsed = ImsParseInboundCsvSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid CSV import payload" });
      return;
    }
    const { category, csv, fileBase64, vendorId } = parsed.data;
    const parsedRows = csv
      ? parseInventoryCsv(category, csv)
      : parseInventoryUpload(category, Buffer.from(fileBase64!.replace(/^data:[^,]*,/, ""), "base64"));
    const enriched = parsed.data.enrichGia
      ? await enrichInboundCsvWithGia(parsedRows)
      : parsedRows;
    res.json(await annotateRestocks(enriched, vendorId ?? null));
  })
);

imsRouter.post(
  "/documents/email",
  wrap(async (req, res) => {
    const parsed = ImsEmailDocumentsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    const { documentIds, to, subject, message } = parsed.data;
    const result = await emailDocuments(documentIds, { to, subject, message });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ documents: result.documents });
  })
);

imsRouter.get(
  "/documents/:id/pdf",
  wrap(async (req, res) => {
    const pdf = await buildDocumentPdf(req.params.id);
    if (!pdf) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pdf.filename}"`);
    res.setHeader("Content-Length", String(pdf.buffer.length));
    res.end(pdf.buffer);
  })
);

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

imsRouter.post(
  "/documents/:id/void",
  wrap(async (req, res) => {
    const result = await voidDocument(req.params.id, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ document: result.document });
  })
);

imsRouter.delete(
  "/documents/:id",
  wrap(async (req, res) => {
    const result = await deleteDocument(req.params.id);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, summary: result.summary });
  })
);

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

imsRouter.post(
  "/documents/:id/return-to-vendor",
  wrap(async (req, res) => {
    const parsed = ImsRecordReturnSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid return payload" });
      return;
    }
    const result = await recordVendorReturn(req.params.id, parsed.data, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({ returnDocument: result.returnDocument, memo: result.memo });
  })
);
