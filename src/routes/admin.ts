import { Router, type Request, type Response } from "express";

import {
  DeclineAccountBodySchema,
  MarkupUpdateBodySchema,
  UpdateExternalNoteBodySchema,
  UpdateInternalNotesBodySchema
} from "@/contract";

import { requireAdmin } from "../middleware/auth";
import {
  approveAccount,
  deactivateAccount,
  declineAccount,
  reactivateAccount,
  updateCompanyInternalNotes,
  updateCompanyMarkups
} from "../modules/admin/accounts.service";
import {
  getAccountByIdFromDb,
  getCompanyByIdFromDb,
  getDashboardKpisFromDb,
  getRecentPendingSignups,
  getRequestByIdFromDb,
  listAccountsFromDb,
  listCompaniesFromDb,
  listRecentRequestsByCompanyFromDb,
  listRequestsFromDb
} from "../modules/admin/reads";
import {
  addSubstituteItems,
  approveRequestItem,
  completeRequestReview,
  convertRequestToDocument,
  declineRequest,
  rejectRequestItem,
  removeSubstituteItem,
  setRequestItemPending,
  updateRequestExternalNote
} from "../modules/admin/requests.service";

export const adminRouter = Router();

// Every admin route requires the ADMIN role (401 unauth / 403 non-admin).
adminRouter.use(requireAdmin);

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[admin] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────
adminRouter.get("/kpis", wrap(async (_req, res) => res.json(await getDashboardKpisFromDb())));

adminRouter.get("/accounts", wrap(async (_req, res) => res.json(await listAccountsFromDb())));

adminRouter.get(
  "/accounts/:id",
  wrap(async (req, res) => {
    const account = await getAccountByIdFromDb(req.params.id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json(account);
  })
);

adminRouter.get("/companies", wrap(async (_req, res) => res.json(await listCompaniesFromDb())));

adminRouter.get(
  "/companies/:id",
  wrap(async (req, res) => {
    const company = await getCompanyByIdFromDb(req.params.id);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  })
);

adminRouter.get(
  "/companies/:id/recent-requests",
  wrap(async (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 3;
    res.json(await listRecentRequestsByCompanyFromDb(req.params.id, limit));
  })
);

adminRouter.get("/requests", wrap(async (_req, res) => res.json(await listRequestsFromDb())));

adminRouter.get(
  "/requests/:id",
  wrap(async (req, res) => {
    const request = await getRequestByIdFromDb(req.params.id);
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    res.json(request);
  })
);

adminRouter.get(
  "/notifications/pending-signups",
  wrap(async (_req, res) => res.json(await getRecentPendingSignups()))
);

// ── Account actions ─────────────────────────────────────────────────────────
adminRouter.post(
  "/accounts/:id/approve",
  wrap(async (req, res) => res.json(await approveAccount(req.params.id)))
);

adminRouter.post(
  "/accounts/:id/decline",
  wrap(async (req, res) => {
    const body = DeclineAccountBodySchema.safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason ?? null : null;
    res.json(await declineAccount(req.params.id, reason));
  })
);

adminRouter.post(
  "/accounts/:id/reactivate",
  wrap(async (req, res) => res.json(await reactivateAccount(req.params.id)))
);

adminRouter.post(
  "/accounts/:id/deactivate",
  wrap(async (req, res) => res.json(await deactivateAccount(req.params.id)))
);

// ── Company actions ─────────────────────────────────────────────────────────
adminRouter.patch(
  "/companies/:id/markups",
  wrap(async (req, res) => {
    const body = MarkupUpdateBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid markups" });
      return;
    }
    res.json(await updateCompanyMarkups(req.params.id, body.data));
  })
);

adminRouter.patch(
  "/companies/:id/internal-notes",
  wrap(async (req, res) => {
    const body = UpdateInternalNotesBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await updateCompanyInternalNotes(req.params.id, body.data.internalNotes));
  })
);

// ── Request-item actions ────────────────────────────────────────────────────
adminRouter.post(
  "/request-items/:itemId/approve",
  wrap(async (req, res) => res.json(await approveRequestItem(req.params.itemId)))
);

adminRouter.post(
  "/request-items/:itemId/reject",
  wrap(async (req, res) => res.json(await rejectRequestItem(req.params.itemId)))
);

adminRouter.post(
  "/request-items/:itemId/pending",
  wrap(async (req, res) => res.json(await setRequestItemPending(req.params.itemId)))
);

// ── Request actions ─────────────────────────────────────────────────────────
adminRouter.patch(
  "/requests/:id/external-note",
  wrap(async (req, res) => {
    const body = UpdateExternalNoteBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await updateRequestExternalNote(req.params.id, body.data.externalNote));
  })
);

adminRouter.post(
  "/requests/:id/complete-review",
  wrap(async (req, res) => res.json(await completeRequestReview(req.params.id)))
);

// Decline & close (#0036) — deny every remaining item + finalize the review.
adminRouter.post(
  "/requests/:id/decline",
  wrap(async (req, res) => res.json(await declineRequest(req.params.id)))
);

// Convert an approved request into a Memo Out / Invoice (#0035, Option A). The
// creating admin comes from the session (requireAdmin guarantees req.user).
adminRouter.post(
  "/requests/:id/convert",
  wrap(async (req, res) => {
    const result = await convertRequestToDocument(req.params.id, req.user!.id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({
      document: result.document,
      request: result.request,
      ...(result.warning ? { warning: result.warning } : {})
    });
  })
);

// Add owned inventory items to a request as dealer-offered substitutes (#0038).
adminRouter.post(
  "/requests/:id/substitutes",
  wrap(async (req, res) => {
    const ids = (req.body as { inventoryItemIds?: unknown })?.inventoryItemIds;
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === "string")) {
      res.status(400).json({ error: "inventoryItemIds must be an array of strings" });
      return;
    }
    const result = await addSubstituteItems(req.params.id, ids as string[]);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.request);
  })
);

// Remove a dealer-added substitute line.
adminRouter.delete(
  "/request-items/:itemId",
  wrap(async (req, res) => {
    const result = await removeSubstituteItem(req.params.itemId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.request);
  })
);
