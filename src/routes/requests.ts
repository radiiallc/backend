import { Router, type NextFunction, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth";
import { getRequestForBuyer, listRequestsForBuyer } from "../modules/requests/reads";
import { submitRequest } from "../modules/requests/submit.service";

export const requestsRouter = Router();

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
      console.error("[requests] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function userIdOf(req: Request): string {
  return req.user!.id;
}

requestsRouter.post(
  "/",
  requireBuyer,
  wrap(async (req, res) => {
    res.json(await submitRequest(userIdOf(req), req.body));
  })
);

requestsRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await listRequestsForBuyer(userIdOf(req)));
  })
);

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
