/**
 * src/lib/request-id.ts
 *
 * Injects a per-request ID into every Hono context so log lines
 * from concurrent requests can be correlated even when they share
 * the same sessionId.
 *
 * Behaviour:
 *   - Reads x-request-id from the incoming request (trusted from
 *     internal callers / load balancers); generates a new ID if absent.
 *   - Sets x-request-id on the outgoing response.
 *   - Exposes reqId via c.get("reqId") for downstream handlers.
 */

import type { Context, Next } from "hono";
import { randomUUID } from "crypto";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
  }
}

export async function requestIdMiddleware(
  c: Context,
  next: Next
): Promise<void | Response> {
  const reqId =
    c.req.header("x-request-id") ??
    randomUUID().replace(/-/g, "").slice(0, 16);

  c.set("reqId", reqId);
  c.header("x-request-id", reqId);
  await next();
}
