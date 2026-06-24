import { Router, type Request, type Response } from "express";

import {
  CreateInventoryItemSchema,
  MediaSlotSchema,
  RequestUploadUrlSchema,
  SetMediaPathSchema,
  TogglePortalVisibilitySchema,
  UpdateInventoryItemSchema
} from "@/contract";

import { requireStaff } from "../../middleware/auth";
import {
  createInventoryItem,
  togglePortalVisibility,
  updateInventoryItem
} from "../../modules/ims/inventory.service";
import {
  getMediaUrl,
  removeMedia,
  requestUploadUrl,
  setMediaPath
} from "../../modules/ims/media.service";
import {
  getInventoryItem,
  listInventoryItems,
  parseInventoryListParams
} from "../../modules/ims/reads";

export const inventoryRouter = Router();

// Every IMS inventory route requires ADMIN or STAFF (401 unauth / 403 buyer).
inventoryRouter.use(requireStaff);

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ims/inventory] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────
inventoryRouter.get(
  "/",
  wrap(async (req, res) => {
    const params = parseInventoryListParams(req.query as Record<string, string | string[]>);
    res.json(await listInventoryItems(params));
  })
);

inventoryRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const item = await getInventoryItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json(item);
  })
);

// ── Writes ──────────────────────────────────────────────────────────────────
inventoryRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = CreateInventoryItemSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid item", issues: body.error.flatten() });
      return;
    }
    // requireStaff guarantees req.user.
    const result = await createInventoryItem(body.data, req.user!.id);
    res.status(result.ok ? 201 : 400).json(result);
  })
);

inventoryRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const body = UpdateInventoryItemSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid update", issues: body.error.flatten() });
      return;
    }
    const result = await updateInventoryItem(req.params.id, body.data);
    res.status(result.ok ? 200 : result.error === "Item not found" ? 404 : 400).json(result);
  })
);

inventoryRouter.patch(
  "/:id/visibility",
  wrap(async (req, res) => {
    const body = TogglePortalVisibilitySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    const result = await togglePortalVisibility(req.params.id, body.data.visibleOnPortal);
    res.status(result.ok ? 200 : result.error === "Item not found" ? 404 : 400).json(result);
  })
);

// ── Media (H3.3) — stones only ────────────────────────────────────────────────
function parseSlot(raw: string): "photo1" | "photo2" | "video" | null {
  const parsed = MediaSlotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// 1) Request a signed upload URL the browser PUTs the file straight to.
inventoryRouter.post(
  "/:id/media/:slot/upload-url",
  wrap(async (req, res) => {
    const slot = parseSlot(req.params.slot);
    if (!slot) {
      res.status(400).json({ error: "Invalid media slot" });
      return;
    }
    const body = RequestUploadUrlSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "filename is required" });
      return;
    }
    const result = await requestUploadUrl(req.params.id, slot, body.data.filename);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.data);
  })
);

// 2) Confirm the uploaded object onto the row.
inventoryRouter.put(
  "/:id/media/:slot",
  wrap(async (req, res) => {
    const slot = parseSlot(req.params.slot);
    if (!slot) {
      res.status(400).json({ error: "Invalid media slot" });
      return;
    }
    const body = SetMediaPathSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const result = await setMediaPath(req.params.id, slot, body.data.path);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, ...result.data });
  })
);

// Signed read URL for display (null when the slot is empty).
inventoryRouter.get(
  "/:id/media/:slot/url",
  wrap(async (req, res) => {
    const slot = parseSlot(req.params.slot);
    if (!slot) {
      res.status(400).json({ error: "Invalid media slot" });
      return;
    }
    const result = await getMediaUrl(req.params.id, slot);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.data);
  })
);

inventoryRouter.delete(
  "/:id/media/:slot",
  wrap(async (req, res) => {
    const slot = parseSlot(req.params.slot);
    if (!slot) {
      res.status(400).json({ error: "Invalid media slot" });
      return;
    }
    const result = await removeMedia(req.params.id, slot);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, ...result.data });
  })
);
