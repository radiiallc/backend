import { Router } from "express";

import {
  verifyCredentials,
  requestPasswordReset,
  resetPassword,
  validateResetToken,
  submitSignupRequest
} from "../modules/auth/auth.service";
import {
  SESSION_COOKIE,
  signSession,
  sessionCookieOptions,
  clearCookieOptions
} from "../modules/auth/session";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const user = await verifyCredentials(email, password);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = await signSession(user);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.json({ user });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, clearCookieOptions());
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post("/signup", async (req, res) => {
  const result = await submitSignupRequest(req.body ?? {});
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

authRouter.post("/password/forgot", async (req, res) => {
  const result = await requestPasswordReset(String(req.body?.email ?? ""));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

authRouter.post("/password/reset", async (req, res) => {
  const result = await resetPassword({
    tokenId: String(req.body?.tokenId ?? ""),
    token: String(req.body?.token ?? ""),
    newPassword: String(req.body?.newPassword ?? "")
  });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

authRouter.get("/password/validate", async (req, res) => {
  const valid = await validateResetToken(
    String(req.query.id ?? ""),
    String(req.query.token ?? "")
  );
  res.json({ valid });
});
