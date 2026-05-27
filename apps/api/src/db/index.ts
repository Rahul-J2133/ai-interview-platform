/**
 * src/db/index.ts — production hardened
 *
 * Changes from original:
 *
 * [HIGH-7] No connection pool ceiling relative to DB server limits
 *   - max reduced from 20 → 5 (configure via DB_POOL_MAX env var)
 *   - max_lifetime added (recycle connections every 5 min to
 *     prevent stale TCP connections from being reused silently)
 *   - idle_timeout reduced to 20s
 *
 * The recommended value for max is:
 *   Math.floor(db_max_connections / num_processes) - safety_margin
 *
 * For a Neon/RDS free-tier DB (25 max connections) with 2 processes:
 *   Math.floor(25 / 2) - 2 = 10   ← set DB_POOL_MAX=10
 *
 * For a Neon/RDS standard (100 max connections) with 4 processes:
 *   Math.floor(100 / 4) - 5 = 20  ← set DB_POOL_MAX=20
 *
 * Default is 5, which is safe for a single process against any tier.
 *
 * For high-concurrency deployments, put PgBouncer in front of Postgres
 * and set max to a higher value — the pooler handles fan-in.
 */

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

declare global {
  // Survive HMR restarts in development without creating new pool connections
  // eslint-disable-next-line no-var
  var __dbInstance: PostgresJsDatabase<typeof schema> | undefined;
}

function buildDb(): PostgresJsDatabase<typeof schema> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set.\n" +
        "Ensure .env exists and is loaded before the first DB call.\n" +
        "Copy .env.example → .env and fill in your Postgres URL."
    );
  }

  // Pool size: configurable via DB_POOL_MAX, default 5.
  // Set this to floor(db_max_connections / num_processes) - margin.
  const maxConnections = parseInt(process.env.DB_POOL_MAX ?? "5", 10);

  const client = postgres(url, {
    max: maxConnections,
    idle_timeout: 20,          // release idle connections after 20s
    connect_timeout: 10,
    max_lifetime: 300,         // recycle connections every 5 min
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
    onnotice: () => {},        // suppress pg NOTICE logs in tests
  });

  return drizzle(client, {
    schema,
    logger: process.env.NODE_ENV === "development",
  });
}

function getDb(): PostgresJsDatabase<typeof schema> {
  if (!globalThis.__dbInstance) {
    globalThis.__dbInstance = buildDb();
  }
  return globalThis.__dbInstance;
}

/**
 * `db` — every property access defers to getDb(), which reads
 * DATABASE_URL at that point (well after dotenv has run).
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop: keyof PostgresJsDatabase<typeof schema>) {
    const database = getDb();
    return database[prop];
  },
  has(_target, prop: keyof PostgresJsDatabase<typeof schema>) {
    const database = getDb();
    return prop in database;
  },
});

export type Database = typeof db;

export * from "./schema.js";
export { schema };
