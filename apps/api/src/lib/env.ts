/**
 * src/lib/env.ts — production hardened
 *
 * Changes from original:
 *   - REDIS_URL added as optional (required for multi-process SSE pub/sub)
 *   - INTERNAL_SECRET added as optional (protects /internal/health)
 *   - DB_POOL_MAX added as optional (overrides default connection pool size)
 *   - RESPONSE_TIMEOUT_MS added as optional (AI call timeout)
 *   - SESSION_INIT_TIMEOUT_MS added as optional
 *
 * Everything else unchanged.
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), override: false });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
        `Make sure apps/api/.env exists (copy .env.example and fill it in).`
    );
  }
  return val;
}

function optional_env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const env = {
  // Database
  DATABASE_URL: require_env("DATABASE_URL"),

  // Groq
  GROQ_API_KEY: require_env("GROQ_API_KEY"),

  // Clerk
  CLERK_DOMAIN: require_env("CLERK_DOMAIN"),
  CLERK_WEBHOOK_SECRET: require_env("CLERK_WEBHOOK_SECRET"),

  // Server
  PORT: parseInt(optional_env("PORT", "4000")),
  WEB_URL: optional_env("WEB_URL", "http://localhost:3000"),
  NODE_ENV: optional_env("NODE_ENV", "development"),
  LOG_LEVEL: optional_env("LOG_LEVEL", "info"),

  // Redis — optional, enables multi-process SSE pub/sub and rate limit store
  // When absent, SSE uses an in-process Map (single-process only)
  REDIS_URL: process.env.REDIS_URL ?? null,

  // Internal diagnostics endpoint secret — set to a long random string in prod
  INTERNAL_SECRET: process.env.INTERNAL_SECRET ?? null,

  // DB pool size per process (see src/db/index.ts for sizing guidance)
  DB_POOL_MAX: parseInt(optional_env("DB_POOL_MAX", "5")),

  // AI response timeout (ms) — kill hanging AI calls
  RESPONSE_TIMEOUT_MS: parseInt(optional_env("RESPONSE_TIMEOUT_MS", "45000")),

  // Session initialization timeout (ms)
  SESSION_INIT_TIMEOUT_MS: parseInt(optional_env("SESSION_INIT_TIMEOUT_MS", "30000")),
} as const;

export type Env = typeof env;
