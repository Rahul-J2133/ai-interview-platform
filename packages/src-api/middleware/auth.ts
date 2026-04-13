/**
 * Clerk auth middleware.
 *
 * Verifies the Clerk JWT, maps clerkUserId → our internal UUID,
 * and attaches ONLY the internal UUID to the Hono context.
 * Downstream handlers never see or use the Clerk ID.
 */

import { env } from "../lib/env"; // ← loads dotenv before anything else
import type { Context, Next } from "hono";
import { db, users } from "@interview/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { JsonWebKey } from "crypto";

// ============================================================
// JWKS CACHE
// ============================================================

interface JwkKey {
  kid: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys: JwkKey[];
}

let _jwks: JwksResponse | null = null;
let _jwksLastFetch = 0;
const JWKS_TTL_MS = 300_000; // 5 minutes

async function getJwks(): Promise<JwksResponse> {
  if (_jwks && Date.now() - _jwksLastFetch < JWKS_TTL_MS) return _jwks;

  const jwksUrl = `https://${env.CLERK_DOMAIN}/.well-known/jwks.json`;
  const res = await fetch(jwksUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUrl}: HTTP ${res.status}`);
  }

  _jwks = (await res.json()) as JwksResponse;
  _jwksLastFetch = Date.now();
  return _jwks;
}

// ============================================================
// TOKEN VERIFICATION
// ============================================================

interface ClerkTokenPayload {
  sub: string;        // Clerk user ID
  exp?: number;
  iat?: number;
  email?: string;
}

async function verifyClerkToken(token: string): Promise<ClerkTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected 3 parts");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
    kid?: string;
    alg?: string;
  };

  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8")
  ) as ClerkTokenPayload;

  // Expiry check
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT has expired");
  }

  // Signature verification
  const jwks = await getJwks();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`No matching JWK for kid: ${header.kid ?? "undefined"}`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBytes = Buffer.from(signatureB64, "base64url");

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    sigBytes,
    Buffer.from(signingInput)
  );

  if (!valid) throw new Error("JWT signature is invalid");

  return payload;
}

// ============================================================
// CONTEXT TYPES
// ============================================================

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

// ============================================================
// MIDDLEWARE
// ============================================================

export async function clerkAuthMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      { data: null, error: { code: "MISSING_TOKEN", message: "Authorization header required" } },
      401
    );
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifyClerkToken(token);
    const clerkUserId = payload.sub;

    // Map Clerk ID → our internal UUID
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    if (!user) {
      return c.json(
        {
          data: null,
          error: {
            code: "USER_NOT_PROVISIONED",
            message: "User exists in Clerk but not in our system. The webhook may not have fired yet.",
          },
        },
        404
      );
    }

    // From here on, ONLY internalUserId flows through the system
    c.set("auth", {
      internalUserId: user.id,
      clerkUserId,
      email: user.email,
    });

    await next();
  } catch (err) {
    logger.warn({ err: String(err) }, "Auth middleware rejected request");
    return c.json(
      { data: null, error: { code: "INVALID_TOKEN", message: "Token verification failed" } },
      401
    );
  }
}
