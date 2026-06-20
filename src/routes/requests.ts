import { Router, type NextFunction, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth";
import { getRequestForBuyer, listRequestsForBuyer } from "../modules/requests/reads";
import { submitRequest } from "../modules/requests/submit.service";

export const requestsRouter = Router();

// All buyer request routes require a session; submit additionally requires the
// buyer capability (BUYER or ADMIN) — mirrors the pre-split server action.
requestsRouter.use(requireAuth);

function requireBuyer(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.role;
  if (role !== "BUYER" && role !== "ADMIN") {
    res.status(403).json({ ok: false, error: "Not authorized" });
    return;
  }
  next();
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[requests] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function userIdOf(req: Request): string {
  return req.user!.id;
}

// Submit a memo/invoice request from selected cart items. Echoes the
// SubmitRequestResult body (always 200) the portal client already branches on.
requestsRouter.post(
  "/",
  requireBuyer,
  wrap(async (req, res) => {
    res.json(await submitRequest(userIdOf(req), req.body));
  })
);

// Buyer request history.
requestsRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await listRequestsForBuyer(userIdOf(req)));
  })
);

// Buyer request detail (ownership enforced in the read; 404 if not owned/found).
requestsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const detail = await getRequestForBuyer(userIdOf(req), req.params.id);
    if (!detail) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    res.json(detail);
  })
);
