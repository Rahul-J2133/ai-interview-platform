/**
 * src/middleware/auth.ts
 *
 * Clerk auth middleware — production hardened.
 *
 * Changes from original:
 *   - JWT verification delegated to src/lib/verify-clerk-jwt.ts
 *     (eliminates the duplicate implementation that lived here)
 *   - DB lookup errors are caught and returned as 503 rather than
 *     leaking as unhandled rejections
 */

import type { Context, Next } from "hono";
import { db, users } from "../db/index.js";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { verifyClerkJwt } from "../lib/verify-clerk-jwt.js";

// ── Context type augmentation ──────────────────────────────

export interface AuthContext {
  /** Our internal UUID — the only ID propagated through the system */
  internalUserId: string;
  /** Clerk sub claim — stored for reference only, never used as FK */
  clerkUserId: string;
  /** Email from our users table */
  email: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// ── Middleware ─────────────────────────────────────────────

export async function clerkAuthMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        data: null,
        error: {
          code: "MISSING_TOKEN",
          message: "Authorization header required",
        },
      },
      401
    );
  }

  const token = authHeader.slice(7);

  let clerkUserId: string;
  try {
    const payload = await verifyClerkJwt(token);
    clerkUserId = payload.sub;
  } catch (err) {
    logger.warn(
      { event: "auth.jwt_invalid", err: String(err), reqId: c.get("reqId") },
      "JWT verification failed"
    );
    return c.json(
      {
        data: null,
        error: { code: "INVALID_TOKEN", message: "Token verification failed" },
      },
      401
    );
  }

  let user: { id: string; email: string } | undefined;
  try {
    [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);
  } catch (err) {
    logger.error(
      { event: "auth.db_error", err: String(err), reqId: c.get("reqId") },
      "DB error during auth user lookup"
    );
    return c.json(
      {
        data: null,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication service temporarily unavailable",
        },
      },
      503
    );
  }

  if (!user) {
    return c.json(
      {
        data: null,
        error: {
          code: "USER_NOT_PROVISIONED",
          message:
            "User exists in Clerk but not in our system. The webhook may not have fired yet.",
        },
      },
      404
    );
  }

  c.set("auth", {
    internalUserId: user.id,
    clerkUserId,
    email: user.email,
  });

  await next();
}
