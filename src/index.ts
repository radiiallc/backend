import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { env } from "./env";
import { prisma } from "@/db";
import { attachUser } from "./middleware/auth";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { cartRouter } from "./routes/cart";
import { cronRouter } from "./routes/cron";
import { favoritesRouter } from "./routes/favorites";
import { internalRouter } from "./routes/internal";
import { profileRouter } from "./routes/profile";
import { requestsRouter } from "./routes/requests";

const app = express();
// CORS with credentials so the browser frontends can set/send the session
// cookie. Reflects only allow-listed origins (never `*` with credentials).
app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin / non-browser (no Origin header) + allow-listed origins
      if (!origin || env.allowedOrigins.includes(origin)) return cb(null, true);
      // Log the rejected origin so a misconfigured ALLOWED_ORIGINS surfaces in
      // the host logs instead of an opaque 500 + a generic "can't reach server"
      // in the browser. Show the current allow-list to make the fix obvious.
      // eslint-disable-next-line no-console
      console.warn(
        `[cors] rejected origin ${origin}; allowed: ${env.allowedOrigins.join(", ") || "(none)"}`
      );
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

// Health / keep-warm — no auth. Warms the Prisma connection pool with a trivial
// query so the first real request to a cold instance doesn't pay connect cost.
// Mirrors the portal's /api/health keep-warm ([[project-2026-06-17-cold-start-not-db]]).
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "api", db: "up", ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, service: "api", db: "down", error: String(err) });
  }
});

// Liveness only (no DB) — for uptime pingers that must not touch the pool.
app.get("/health/live", (_req, res) => {
  res.json({ ok: true, service: "api", ts: new Date().toISOString() });
});

// Feature routers
app.use("/auth", authRouter);
app.use("/catalog", catalogRouter);
app.use("/cart", cartRouter);
app.use("/favorites", favoritesRouter);
app.use("/profile", profileRouter);
app.use("/requests", requestsRouter);
app.use("/admin", adminRouter);
app.use("/cron", cronRouter);
app.use("/internal", internalRouter);

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${env.port} (${env.nodeEnv})`);
});

function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} received, shutting down`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
