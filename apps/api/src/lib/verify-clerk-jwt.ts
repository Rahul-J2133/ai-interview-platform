/**
 * src/lib/verify-clerk-jwt.ts
 *
 * Single source of truth for Clerk JWT verification.
 *
 * Previously the codebase had two independent implementations:
 *   - src/middleware/auth.ts  (Web Crypto API, 5-min JWKS TTL)
 *   - src/sse/handler.ts      (Node crypto, 10-min JWKS TTL)
 *
 * Having two implementations means any security fix, clock-skew
 * adjustment, or key-rotation handling must be applied twice —
 * and divergence between them is a silent auth inconsistency.
 *
 * This module is the one implementation. Both auth.ts and the
 * SSE handler import from here.
 *
 * Key design decisions:
 *   - JWKS fetched with a 5-second AbortController timeout
 *   - JWKS cached for 5 minutes; cache invalidated on unknown kid
 *     so key rotation is picked up within one TTL without a restart
 *   - `nbf` (not-before) and `exp` (expiry) both validated
 *   - Algorithm locked to RS256; any other algorithm is rejected
 *     (algorithm confusion attacks)
 */

import { env } from "./env.js";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────

export interface ClerkTokenPayload {
  sub: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
}

interface JwkKey {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys: JwkKey[];
}

// ── JWKS cache ─────────────────────────────────────────────

const JWKS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JWKS_FETCH_TIMEOUT_MS = 5_000;

let _cachedKeys: Map<string, CryptoKey> = new Map();
let _cachePopulatedAt = 0;

function jwksUrl(): string {
  return `https://${env.CLERK_DOMAIN}/.well-known/jwks.json`;
}

async function fetchAndCacheJwks(): Promise<Map<string, CryptoKey>> {
  const url = jwksUrl();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JWKS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as JwksResponse;

    const keyMap = new Map<string, CryptoKey>();
    await Promise.all(
      body.keys
        .filter((k) => k.kty === "RSA" && k.alg === "RS256")
        .map(async (k) => {
          const cryptoKey = await crypto.subtle.importKey(
            "jwk",
            k as JsonWebKey,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"]
          );
          keyMap.set(k.kid, cryptoKey);
        })
    );

    logger.debug(
      { event: "jwks.fetched", keyCount: keyMap.size },
      `JWKS refreshed — ${keyMap.size} RS256 keys`
    );

    _cachedKeys = keyMap;
    _cachePopulatedAt = Date.now();
    return keyMap;
  } finally {
    clearTimeout(timer);
  }
}

async function getPublicKey(kid: string): Promise<CryptoKey> {
  const now = Date.now();
  const cacheValid = now - _cachePopulatedAt < JWKS_TTL_MS;

  if (cacheValid && _cachedKeys.has(kid)) {
    return _cachedKeys.get(kid)!;
  }

  // Cache miss or TTL expired — refresh
  const keys = await fetchAndCacheJwks();

  const key = keys.get(kid);
  if (!key) {
    // kid not found even after refresh → Clerk hasn't published it yet
    // or the token was signed by a revoked key
    throw new Error(`No JWKS key found for kid: ${kid}`);
  }
  return key;
}

// ── Verification ───────────────────────────────────────────

export async function verifyClerkJwt(
  token: string
): Promise<ClerkTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected 3 parts");

  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  // Decode header
  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
  } catch {
    throw new Error("Failed to decode JWT header");
  }

  // Lock algorithm to RS256 — reject alg:none, HS256, etc.
  if (header.alg !== "RS256") {
    throw new Error(
      `Rejected JWT algorithm: ${header.alg ?? "none"} (expected RS256)`
    );
  }
  if (!header.kid) throw new Error("JWT header missing kid");

  // Verify signature
  const publicKey = await getPublicKey(header.kid);
  const signingInput = `${rawHeader}.${rawPayload}`;
  const sigBytes = Buffer.from(rawSig, "base64url");

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    sigBytes,
    Buffer.from(signingInput)
  );
  if (!valid) throw new Error("JWT signature verification failed");

  // Decode payload
  let payload: ClerkTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Failed to decode JWT payload");
  }

  // Validate time claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && payload.exp < now) {
    throw new Error("JWT has expired");
  }
  if (payload.nbf !== undefined && payload.nbf > now + 30) {
    // 30-second clock-skew tolerance
    throw new Error("JWT not yet valid (nbf)");
  }
  if (!payload.sub) throw new Error("JWT missing sub claim");

  return payload;
}
