import { Router, type NextFunction, type Request, type Response } from "express";

import { AddToCartBodySchema, UpdateCartQtyBodySchema } from "@/contract";

import { requireAuth } from "../middleware/auth";
import {
  addToCart,
  clearCart,
  getCartCount,
  getCartPreview,
  removeFromCart,
  updateCartItemQty
} from "../modules/cart/cart.service";
import { getCartForBuyer } from "../modules/cart/reads";

export const cartRouter = Router();

cartRouter.use(requireAuth);

function requireBuyer(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.role;
  if (role !== "BUYER" && role !== "ADMIN") {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  next();
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      console.error("[cart] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function userIdOf(req: Request): string {
  return req.user!.id;
}

function companyIdOf(req: Request): string | null {
  return req.user?.companyId ?? null;
}

cartRouter.get(
  "/count",
  wrap(async (req, res) => {
    res.json({ count: await getCartCount(userIdOf(req)) });
  })
);

cartRouter.get(
  "/preview",
  wrap(async (req, res) => {
    res.json(await getCartPreview(userIdOf(req), companyIdOf(req)));
  })
);

cartRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await getCartForBuyer(userIdOf(req), companyIdOf(req)));
  })
);

cartRouter.post(
  "/items",
  requireBuyer,
  wrap(async (req, res) => {
    const body = AddToCartBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await addToCart(userIdOf(req), body.data.itemId, body.data.qty ?? 1));
  })
);

cartRouter.patch(
  "/items/:cartItemId",
  requireBuyer,
  wrap(async (req, res) => {
    const body = UpdateCartQtyBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await updateCartItemQty(userIdOf(req), req.params.cartItemId, body.data.qty));
  })
);

cartRouter.delete(
  "/items/:cartItemId",
  requireBuyer,
  wrap(async (req, res) => {
    res.json(await removeFromCart(userIdOf(req), req.params.cartItemId));
  })
);

cartRouter.delete(
  "/",
  requireBuyer,
  wrap(async (req, res) => {
    res.json(await clearCart(userIdOf(req)));
  })
);
