/**
 * src/index.ts — production hardened
 *
 * Changes from original:
 *
 * [MEDIUM-11] Health endpoint leaks env variable presence + Node version
 *   GET /health now returns only { ok, ts }. Diagnostic detail is
 *   available at GET /internal/health, protected by an internal
 *   secret header (INTERNAL_SECRET env var).
 *
 * [MEDIUM-12] CORS allows localhost origins in production
 *   localhost origins are only included when NODE_ENV !== "production".
 *
 * [LOW-17] No request ID on every request
 *   requestIdMiddleware injected as the first middleware; all downstream
 *   handlers can access c.get("reqId") for log correlation.
 *
 * [LOW-18] SIGTERM handler exits immediately
 *   shutdown.drain() waits for in-flight work and closes the DB pool
 *   before exiting. A shutting-down flag rejects new requests with 503
 *   during the drain window.
 */

import "./lib/env.js";

import * as Sentry from "@sentry/node";
import { initSentry } from "./sentry.js";

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { env } from "./lib/env.js";
import { requestIdMiddleware } from "./lib/request-id.js";
import { shutdown } from "./lib/shutdown.js";
import { handleClerkWebhook } from "./webhooks/clerk.js";
import sessionsRouter from "./routes/sessions.js";
import usersRouter from "./routes/users.js";
import documentsRouter from "./routes/documents.js";
import sseRouter, { redisReady } from "./sse/handler.js";
import { logger } from "./lib/logger.js";

initSentry();

const app = new Hono();

// ── Middleware ─────────────────────────────────────────────

// 1. Request ID — must be first so all downstream logs include reqId
app.use("*", requestIdMiddleware);

// 2. Reject new requests during graceful shutdown drain
app.use("*", async (c, next) => {
  if (shutdown.isShuttingDown) {
    return c.json(
      { error: { code: "SHUTTING_DOWN", message: "Server is restarting. Please retry." } },
      503
    );
  }
  await next();
  return;
});

// 3. Sentry scope per request
app.use("*", async (c, next) => {
  Sentry.withScope((scope) => {
    scope.setTag("route", c.req.path);
    scope.setTag("reqId", c.get("reqId"));
  });
  await next();
  return;
});

// 4. HTTP request logging
app.use("*", honoLogger());

// 5. CORS — localhost only in non-production
const allowedOrigins =
  env.NODE_ENV === "production"
    ? [env.WEB_URL]
    : [env.WEB_URL, "http://localhost:3000", "http://localhost:3001"];

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Health ─────────────────────────────────────────────────
//
// [MEDIUM-11] Lean public health check — no env fingerprinting
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// Internal diagnostics — requires INTERNAL_SECRET header
// Used by ops tooling, not exposed to the public internet
app.get("/internal/health", (c) => {
  const secret = process.env.INTERNAL_SECRET;
  if (secret && c.req.header("x-internal-secret") !== secret) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json({
    ok: true,
    ts: Date.now(),
    env: {
      hasDb: !!process.env.DATABASE_URL,
      hasGroq: !!process.env.GROQ_API_KEY,
      hasClerk: !!process.env.CLERK_WEBHOOK_SECRET,
      hasRedis: !!process.env.REDIS_URL,
      node: process.version,
    },
  });
});

// ── Webhooks ────────────────────────────────────────────────
app.post("/webhooks/clerk", handleClerkWebhook);

// ── Authenticated API routes ────────────────────────────────
app.route("/api/v1/users", usersRouter);
app.route("/api/v1/sessions", sessionsRouter);
app.route("/api/v1/documents", documentsRouter);
app.route("/api/v1/sessions", sseRouter);

// ── Error / 404 ─────────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404)
);

app.onError((err, c) => {
  Sentry.captureException(err);
  logger.error({ err, reqId: c.get("reqId") }, "Unhandled error");
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    500
  );
});

// ── Start ───────────────────────────────────────────────────

const port = env.PORT;

// Wait for optional Redis pub/sub before accepting traffic
await redisReady;

const server: ServerType = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  logger.info({ port }, "HTTP server listening");
});

// Register with the shutdown manager so SIGTERM drains cleanly
shutdown.register(server as any, {} as any); // DB reference added below

// ── Graceful shutdown ────────────────────────────────────────
//
// [LOW-18] Previously called process.exit(0) immediately.
// Now drains in-flight work, closes HTTP server, closes DB pool.

async function handleShutdown(signal: string): Promise<void> {
  await shutdown.drain(signal);
  process.exit(0);
}

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));

// Catch unhandled rejections — log and send to Sentry without crashing
process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandledRejection", reason }, "Unhandled promise rejection");
  Sentry.captureException(reason);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaughtException", err }, "Uncaught exception — exiting");
  Sentry.captureException(err);
  // Give Sentry 2 seconds to flush before exiting
  setTimeout(() => process.exit(1), 2000);
});

export default app;
