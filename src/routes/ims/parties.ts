import { Router, type Request, type Response } from "express";

import {
  CreateClientSchema,
  CreateVendorSchema,
  UpdateClientSchema,
  UpdateVendorSchema
} from "@/contract";

import { requireStaff } from "../../middleware/auth";
import {
  createClient,
  createVendor,
  getClient,
  getVendor,
  listClients,
  listVendors,
  updateClient,
  updateVendor
} from "../../modules/ims/parties.service";

// Vendor + Client CRUD (§5). Both gated by requireStaff (the IMS gate). Kept in
// one file because they're the same minimal shape; mounted at /ims/vendors and
// /ims/clients in index.ts.

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ims/parties] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function one(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = typeof s === "string" ? s.trim() : "";
  return t ? t : undefined;
}

// ── Vendors ────────────────────────────────────────────────────────────────────
export const vendorsRouter = Router();
vendorsRouter.use(requireStaff);

vendorsRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await listVendors(one(req.query.q)));
  })
);

vendorsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const v = await getVendor(req.params.id);
    if (!v) {
      res.status(404).json({ error: "Vendor not found" });
      return;
    }
    res.json(v);
  })
);

vendorsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = CreateVendorSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid vendor", issues: body.error.flatten() });
      return;
    }
    const result = await createVendor(body.data);
    res.status(result.ok ? 201 : 400).json(result);
  })
);

vendorsRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const body = UpdateVendorSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid update", issues: body.error.flatten() });
      return;
    }
    const result = await updateVendor(req.params.id, body.data);
    res.status(result.ok ? 200 : 400).json(result);
  })
);

// ── Clients ────────────────────────────────────────────────────────────────────
export const clientsRouter = Router();
clientsRouter.use(requireStaff);

clientsRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await listClients(one(req.query.q)));
  })
);

clientsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const c = await getClient(req.params.id);
    if (!c) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    res.json(c);
  })
);

clientsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = CreateClientSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid client", issues: body.error.flatten() });
      return;
    }
    const result = await createClient(body.data);
    res.status(result.ok ? 201 : 400).json(result);
  })
);

clientsRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const body = UpdateClientSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid update", issues: body.error.flatten() });
      return;
    }
    const result = await updateClient(req.params.id, body.data);
    res.status(result.ok ? 200 : 400).json(result);
  })
);
