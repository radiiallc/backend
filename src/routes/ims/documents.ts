import { Router, type Request, type Response } from "express";

import { CreateInboundDocumentSchema } from "@/contract";

import { requireStaff } from "../../middleware/auth";
import {
  createInboundDocument,
  voidDocument
} from "../../modules/ims/document.service";
import {
  getDocument,
  listDocuments,
  parseDocumentListParams
} from "../../modules/ims/document.reads";
import {
  buildInboundTemplate,
  importInboundCsv
} from "../../modules/ims/document.import";

// IMS documents (§H4). Inbound creation (Bill In / Memo In / Brand Inventory In),
// list, detail, void, and per-type CSV import + template. All gated by
// requireStaff; mounted at /ims/documents in index.ts.
export const documentsRouter = Router();
documentsRouter.use(requireStaff);

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ims/documents] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────
documentsRouter.get(
  "/",
  wrap(async (req, res) => {
    const params = parseDocumentListParams(req.query as Record<string, string | string[]>);
    res.json(await listDocuments(params));
  })
);

// CSV template download for a document type. Static route declared before /:id
// so "template" isn't captured as an id.
documentsRouter.get(
  "/template/:type",
  wrap(async (req, res) => {
    const itemType = Array.isArray(req.query.itemType)
      ? String(req.query.itemType[0])
      : typeof req.query.itemType === "string"
        ? req.query.itemType
        : undefined;
    const template = buildInboundTemplate(req.params.type, itemType);
    if (!template) {
      res.status(400).json({ error: "Unknown or non-importable document type" });
      return;
    }
    res
      .status(200)
      .type("text/csv")
      .header("Content-Disposition", `attachment; filename="${template.filename}"`)
      .send(template.csv);
  })
);

documentsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const doc = await getDocument(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  })
);

// ── Writes ──────────────────────────────────────────────────────────────────
documentsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = CreateInboundDocumentSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ ok: false, error: "Invalid document", issues: body.error.flatten() });
      return;
    }
    // requireStaff guarantees req.user.
    const result = await createInboundDocument(body.data, req.user!.id);
    res.status(result.ok ? 201 : 400).json(result);
  })
);

// Bulk CSV import → builds an inbound document from N validated rows (§4.5).
// All-or-nothing: 0 rows commit if any row fails validation (gate §6.13).
documentsRouter.post(
  "/import",
  wrap(async (req, res) => {
    const result = await importInboundCsv(req.body, req.user!.id);
    if (!result.ok) {
      // 422 when the CSV parsed but rows failed validation (row errors attached);
      // 400 for a malformed request envelope.
      res.status(result.rowErrors ? 422 : 400).json(result);
      return;
    }
    res.status(201).json(result);
  })
);

documentsRouter.post(
  "/:id/void",
  wrap(async (req, res) => {
    const result = await voidDocument(req.params.id, req.user!.id);
    res.status(result.ok ? 200 : result.error === "Document not found" ? 404 : 400).json(result);
  })
);
