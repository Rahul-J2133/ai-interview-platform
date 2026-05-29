/**
 * src/lib/rate-limit.ts
 *
 * Sliding-window rate limiter middleware for Hono.
 *
 * Uses an in-process Map by default (works on a single server).
 * Swap the store for a Redis implementation when running multiple
 * processes (see RedisRateLimitStore below — requires ioredis/upstash).
 *
 * Usage:
 *   import { rateLimit } from "../lib/rate-limit.js";
 *
 *   // 10 session creates per user per minute
 *   sessions.post("/", rateLimit({ windowMs: 60_000, max: 10, keyFn: authKey }), handler);
 *
 *   // 100 message posts per user per minute
 *   sseRouter.post("/:id/message", rateLimit({ windowMs: 60_000, max: 100, keyFn: authKey }), handler);
 */

import type { Context, MiddlewareHandler } from "hono";
import { logger } from "./logger.js";

// ── Store interface ────────────────────────────────────────

export interface RateLimitStore {
  /** Increment hit count for key. Returns the new count. */
  increment(key: string, windowMs: number): Promise<number>;
}

// ── In-process store ───────────────────────────────────────

interface WindowEntry {
  count: number;
  resetAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private windows = new Map<string, WindowEntry>();

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }

    entry.count++;
    return entry.count;
  }
}

const defaultStore = new MemoryRateLimitStore();

// ── Middleware factory ─────────────────────────────────────

export interface RateLimitOptions {
  /** Window length in milliseconds */
  windowMs: number;
  /** Max requests per window */
  max: number;
  /** Function to derive a rate-limit key from the request context */
  keyFn: (c: Context) => string;
  /** Optional custom store (e.g. Redis for multi-process) */
  store?: RateLimitStore;
  /** Error message returned to the client */
  message?: string;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const store = opts.store ?? defaultStore;

  return async (c, next) => {
    const key = `rl:${opts.windowMs}:${opts.keyFn(c)}`;
    const count = await store.increment(key, opts.windowMs);

    c.header("x-ratelimit-limit", String(opts.max));
    c.header("x-ratelimit-remaining", String(Math.max(0, opts.max - count)));

    if (count > opts.max) {
      logger.warn(
        {
          event: "rate_limit.exceeded",
          key,
          count,
          max: opts.max,
          reqId: c.get("reqId"),
        },
        "Rate limit exceeded"
      );
      return c.json(
        {
          data: null,
          error: {
            code: "RATE_LIMITED",
            message:
              opts.message ??
              "Too many requests. Please slow down and try again.",
          },
        },
        429
      );
    }

    await next();
    return;
  };
}

// ── Convenience key functions ──────────────────────────────

/** Rate-limit by authenticated internal user ID (post-auth routes) */
export function authKey(c: Context): string {
  return `user:${c.get("auth")?.internalUserId ?? "anon"}`;
}

/** Rate-limit by IP address (pre-auth routes like webhooks) */
export function ipKey(c: Context): string {
  return (
    `ip:` +
    (c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown")
  );
}
