/**
 * API Entry Point
 *
 * env.ts MUST be the very first import — it calls dotenv.config()
 * synchronously so that DATABASE_URL, GROQ_API_KEY etc. are available
 * before any other module is evaluated.
 */

import "./lib/env"; // ← FIRST — loads .env before anything else

import * as Sentry from "@sentry/node";
import { initSentry } from "./sentry";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { createServer } from "http";
import { env } from "./lib/env";
import { handleClerkWebhook } from "./webhooks/clerk";
import { createWebSocketServer } from "./ws/server";
import sessionsRouter from "./routes/sessions";
import usersRouter from "./routes/users";
import documentsRouter from "./routes/documents";
import { logger } from "./lib/logger";

initSentry();

const app = new Hono();

// ✅ Middleware: attach request context
app.use("*", async (c, next) => {
  Sentry.withScope((scope) => {
    scope.setTag("route", c.req.path);
  });
  await next();
});

app.use("*", honoLogger());
app.use(
  "*",
  cors({
    origin: [env.WEB_URL, "http://localhost:3000", "http://localhost:3001"],
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "interview-api",
    timestamp: new Date().toISOString(),
    env: {
      hasDb: !!process.env.DATABASE_URL,
      hasGroq: !!process.env.GROQ_API_KEY,
      hasClerk: !!process.env.CLERK_WEBHOOK_SECRET,
      node: process.version,
    },
  }),
);

// Webhooks — no auth middleware (Clerk verifies via svix signature)
app.post("/webhooks/clerk", handleClerkWebhook);

// Authenticated API routes
app.route("/api/v1/users", usersRouter);
app.route("/api/v1/sessions", sessionsRouter);
app.route("/api/v1/documents", documentsRouter);

app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404),
);

app.onError((err, c) => {
  Sentry.captureException(err);
  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    500,
  );
});

// ── HTTP SERVER ───────────────────────────────────────────

const httpPort = env.PORT;
const wsPort = env.PORT + 1;

const httpServer = createServer();

serve({ fetch: app.fetch, port: httpPort, hostname: "0.0.0.0" }, () => {
  logger.info({ port: httpPort }, "HTTP server listening");
});

createWebSocketServer(httpServer);
httpServer.listen(wsPort, () => {
  logger.info({ port: wsPort }, "WebSocket server listening");
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  logger.info("SIGINT — shutting down");
  process.exit(0);
});

export default app;
