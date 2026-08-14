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
import { imsRouter } from "./routes/ims";
import { internalRouter } from "./routes/internal";
import { profileRouter } from "./routes/profile";
import { requestsRouter } from "./routes/requests";
import { startIngestScheduler, startPgStatStatementsMaintenance } from "./scheduler";

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || env.allowedOrigins.includes(origin)) return cb(null, true);
      console.warn(
        `[cors] rejected origin ${origin}; allowed: ${env.allowedOrigins.join(", ") || "(none)"}`
      );
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());
app.use(attachUser);

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "api", db: "up", ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, service: "api", db: "down", error: String(err) });
  }
});

app.get("/health/live", (_req, res) => {
  res.json({ ok: true, service: "api", ts: new Date().toISOString() });
});

app.use("/auth", authRouter);
app.use("/catalog", catalogRouter);
app.use("/cart", cartRouter);
app.use("/favorites", favoritesRouter);
app.use("/profile", profileRouter);
app.use("/requests", requestsRouter);
app.use("/admin", adminRouter);
app.use("/ims", imsRouter);
app.use("/cron", cronRouter);
app.use("/internal", internalRouter);

const server = app.listen(env.port, () => {
  console.log(`[api] listening on :${env.port} (${env.nodeEnv})`);
  startIngestScheduler();
  startPgStatStatementsMaintenance();
});

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
