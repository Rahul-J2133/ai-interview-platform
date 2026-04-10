/**
 * env.ts — Single source of truth for environment variables.
 *
 * Import this module FIRST in every file that needs env vars.
 * It calls dotenv.config() exactly once (idempotent via the
 * module cache) so subsequent imports are free no-ops.
 *
 * Usage:
 *   import { env } from "../lib/env";
 *   const url = env.DATABASE_URL;
 */

import dotenv from "dotenv";
import path from "path";

// Load .env relative to the CWD (apps/api when running `npm run dev`
// from that workspace, or wherever turbo invokes it from).
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
// Fallback: monorepo root (when running `turbo run dev` from root)
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
} as const;

export type Env = typeof env;
