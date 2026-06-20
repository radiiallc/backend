import { Router, type Request, type Response } from "express";

import {
  ChangePasswordBodySchema,
  UpdateBuyerProfileBodySchema,
  UpdateCompanyAddressBodySchema
} from "@/contract";

import { requireAuth } from "../middleware/auth";
import {
  changePassword,
  getBuyerProfile,
  updateBuyerCompanyAddress,
  updateBuyerProfile
} from "../modules/profile/profile.service";

export const profileRouter = Router();

// Profile reads/edits require a session only (no role gate) — mirrors the
// pre-split actions' getSessionUserId().
profileRouter.use(requireAuth);

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[profile] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function userIdOf(req: Request): string {
  return req.user!.id;
}

profileRouter.get(
  "/",
  wrap(async (req, res) => {
    const profile = await getBuyerProfile(userIdOf(req));
    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }
    res.json(profile);
  })
);

profileRouter.patch(
  "/",
  wrap(async (req, res) => {
    const body = UpdateBuyerProfileBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await updateBuyerProfile(userIdOf(req), body.data));
  })
);

profileRouter.patch(
  "/company-address",
  wrap(async (req, res) => {
    const body = UpdateCompanyAddressBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await updateBuyerCompanyAddress(userIdOf(req), body.data.shippingAddress));
  })
);

profileRouter.post(
  "/change-password",
  wrap(async (req, res) => {
    const body = ChangePasswordBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await changePassword(userIdOf(req), body.data));
  })
);
