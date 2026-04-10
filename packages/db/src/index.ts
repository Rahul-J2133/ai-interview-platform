/**
 * packages/db/src/index.ts
 *
 * Lazy DB client — the Postgres connection is created on FIRST
 * property access of `db`, not at module import time.
 *
 * This means DATABASE_URL can be loaded by the app's dotenv call
 * in apps/api/src/lib/env.ts before any DB operation is attempted.
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
      "Ensure apps/api/.env exists and is loaded before the first DB call.\n" +
      "Copy apps/api/.env.example → apps/api/.env and fill in your Postgres URL."
    );
  }

  const client = postgres(url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
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
