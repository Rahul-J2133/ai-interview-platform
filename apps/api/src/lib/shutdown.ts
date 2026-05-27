/**
 * src/lib/shutdown.ts
 *
 * Graceful shutdown manager.
 *
 * Problems solved:
 *   1. SIGTERM handler previously called process.exit(0) immediately,
 *      killing every in-flight AI call, DB write, and SSE emit.
 *   2. Fire-and-forget async closures in POST /message and POST /silence
 *      had no way to keep the process alive until they completed.
 *
 * Usage:
 *   import { shutdown } from "../lib/shutdown.js";
 *
 *   // Register async work that must complete before exit:
 *   shutdown.track(
 *     (async () => {
 *       const result = await InterviewSessionController.handleCandidateResponse(...)
 *       await emitToSession(...)
 *     })()
 *   );
 *
 *   // In index.ts, register the HTTP server and DB pool:
 *   shutdown.register(server, db);
 */

import type { Server } from "http";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { logger } from "./logger.js";

type AnyDatabase = PostgresJsDatabase<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class ShutdownManager {
  private inFlight = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private server: Server | null = null;
  private dbPool: AnyDatabase | null = null;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Call once at startup to hand over the HTTP server and DB pool */
  register(server: Server, db: AnyDatabase): void {
    this.server = server;
    this.dbPool = db;
  }

  /**
   * Track a fire-and-forget promise so the shutdown manager can
   * wait for it before exiting.
   *
   * Returns the original promise unchanged (for chaining).
   */
  track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
    return p;
  }

  /** Called by SIGTERM / SIGINT handlers */
  async drain(signal: string): Promise<void> {
    if (this.shuttingDown) return; // already draining
    this.shuttingDown = true;

    logger.info(
      { event: "shutdown.start", signal, inFlight: this.inFlight.size },
      `${signal} received — draining ${this.inFlight.size} in-flight operations`
    );

    // 1. Stop accepting new HTTP connections
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      logger.info({ event: "shutdown.http_closed" }, "HTTP server closed");
    }

    // 2. Wait for in-flight work with a hard deadline
    const DRAIN_TIMEOUT_MS = 25_000; // stay inside k8s terminationGracePeriodSeconds
    if (this.inFlight.size > 0) {
      const drain = Promise.allSettled([...this.inFlight]);
      const timeout = new Promise<void>((resolve) =>
        setTimeout(() => {
          logger.warn(
            { event: "shutdown.drain_timeout", remaining: this.inFlight.size },
            `Drain timeout — ${this.inFlight.size} operations still running`
          );
          resolve();
        }, DRAIN_TIMEOUT_MS)
      );
      await Promise.race([drain, timeout]);
    }

    // 3. Close DB pool cleanly
    if (this.dbPool) {
      try {
        // Access the underlying postgres.js client via the proxy
        const client = (this.dbPool as any).$client; // eslint-disable-line
        if (client?.end) await client.end({ timeout: 5 });
        logger.info({ event: "shutdown.db_closed" }, "DB pool closed");
      } catch (err) {
        logger.warn({ event: "shutdown.db_close_error", err }, "DB pool close error");
      }
    }

    logger.info({ event: "shutdown.complete" }, "Shutdown complete");
  }
}

export const shutdown = new ShutdownManager();
