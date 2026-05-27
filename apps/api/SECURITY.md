# Security & Resilience Hardening Changelog

This document describes every change made during the production hardening
pass. Changes are grouped by severity and cross-referenced to the audit
finding numbers in the interactive audit report.

---

## Critical fixes

### [1] In-memory SSE registry replaced with Redis pub/sub
**File:** `src/sse/handler.ts`

The `sessionToSse` Map is now a local `localStreams` Map used only as a
write target by the process that holds the SSE connection. Publishing
is done via a Redis channel (`sse:{sessionId}`). Any process that needs
to push an event calls `emitToSession()`, which publishes to Redis; the
subscriber on the SSE-holding process writes to the stream.

When `REDIS_URL` is not set (development, single-process), the system
falls back to the local Map — no behaviour change for simple deployments.

### [2] Fire-and-forget async work registered with ShutdownManager
**Files:** `src/sse/handler.ts`, `src/lib/shutdown.ts`

All `void (async () => {...})()` calls are now wrapped with
`shutdown.track(promise)`. The new `ShutdownManager` class holds a
`Set<Promise>` of in-flight work. On SIGTERM it waits for all tracked
promises (up to 25 seconds) before calling `process.exit(0)`.

### [3] Duplicate JWT verification implementations merged
**Files:** `src/lib/verify-clerk-jwt.ts` (new), `src/middleware/auth.ts`,
`src/sse/handler.ts`

The bespoke Node `crypto` implementation in `sse/handler.ts` and the
Web Crypto implementation in `middleware/auth.ts` are both removed.
`src/lib/verify-clerk-jwt.ts` is the single implementation used by both.

Key improvements over both originals:
- Algorithm locked to RS256 (rejects `alg:none`, HS256, etc.)
- JWKS fetch has a 5-second `AbortController` timeout
- Unknown `kid` invalidates the cache and triggers a fresh fetch
  (handles Clerk key rotation within one TTL without a restart)
- `nbf` claim validated with 30-second clock-skew tolerance

### [4] File type detection uses magic bytes, not Content-Type
**File:** `src/routes/documents.ts`

The document parse route no longer trusts the client-supplied
`Content-Type` or file extension. The first bytes of the upload are
checked against known magic byte signatures (PDF: `%PDF`, DOCX: `PK\x03\x04`).
Plain text is detected by the absence of null bytes. Any file that
doesn't match a known signature is rejected with HTTP 415.

---

## High severity fixes

### [5] Atomic processing lock replaces racy Set
**File:** `src/sse/handler.ts`

`processingSet` replaced with `processingLocks` Map and synchronous
`tryAcquireLock` / `releaseLock` helpers. Because they are synchronous
(no `await` between check and set), Node's single-threaded event loop
makes them atomic.

### [6] JWT removed from query string (nonce-based stream auth)
**File:** `src/sse/handler.ts`

`GET /:id/stream?token=<JWT>` is replaced with a two-step flow:
1. `POST /:id/stream-token` (Bearer-authenticated) → issues a 30-second
   single-use UUID nonce stored in a server-side Map.
2. `GET /:id/stream?nonce=<uuid>` redeems the nonce (deleted immediately
   before any await) and opens the SSE stream.

The JWT never appears in a URL, so it cannot end up in server access
logs, browser history, Referer headers, CDN logs, or Sentry breadcrumbs.

### [7] DB connection pool sized correctly
**File:** `src/db/index.ts`

`max` reduced from hardcoded 20 to 5 (configurable via `DB_POOL_MAX`).
`max_lifetime: 300` added to recycle connections every 5 minutes.
`idle_timeout` reduced to 20 seconds.

See `.env.example` for sizing guidance relative to your DB tier and
process count.

### [8] JWKS fetch timeout
**File:** `src/lib/verify-clerk-jwt.ts`

Both original JWKS fetch paths (raw `https.get` and bare `fetch`) had
no timeout. The unified implementation wraps every fetch in a 5-second
`AbortController`. If Clerk's JWKS endpoint is slow or unreachable,
auth fails fast with a 401 rather than hanging the event loop.

### [9] Session abandon tears down in-memory actor
**Files:** `src/routes/sessions.ts`, `src/services/session-controller.ts`,
`src/sse/handler.ts`

`POST /:id/abandon` now calls:
1. `InterviewSessionController.terminate(sessionId)` — stops the XState
   actor and removes it from all in-memory registries.
2. `forceCloseSession(sessionId)` — releases the processing lock and
   removes the SSE stream entry.

`InterviewSessionController.terminate()` is a new static method added
to the controller.

---

## Medium severity fixes

### [10] Prompt injection heuristic on uploaded documents
**File:** `src/routes/documents.ts`

A lightweight regex scan checks extracted document text for common
instruction-override patterns before it is returned to the caller.
Flagged documents receive a `warning: "CONTENT_POLICY"` field in the
response so the session creation route can decide whether to proceed.

The primary defence (XML tag wrapping in LLM prompts) is already in
`session-controller.ts` and is unchanged.

### [11] Health endpoint no longer leaks environment info
**File:** `src/index.ts`

`GET /health` returns only `{ ok: true, ts: number }`.

Diagnostic detail (env vars present, Node version) moved to
`GET /internal/health`, which requires an `x-internal-secret` header
matching the `INTERNAL_SECRET` environment variable.

### [12] CORS localhost origins gated to non-production
**File:** `src/index.ts`

`http://localhost:3000` and `http://localhost:3001` are only included
in the CORS `origin` array when `NODE_ENV !== "production"`.

### [13] Rate limiting on all expensive routes
**Files:** `src/lib/rate-limit.ts` (new), `src/routes/sessions.ts`,
`src/routes/documents.ts`, `src/sse/handler.ts`

Sliding-window rate limiter added:
- `POST /sessions` — 10 per user per minute
- `POST /:id/message` — 60 per user per minute
- `POST /documents/parse` — 20 per user per minute
- `POST /documents/retrieve` — 30 per user per minute

The `MemoryRateLimitStore` is used by default (single-process). The
`RateLimitStore` interface can be swapped for a Redis implementation
when running multiple processes.

### [14] Webhook idempotency gate is now atomic
**File:** `src/webhooks/clerk.ts`

The original SELECT-then-INSERT pattern had a TOCTOU race where two
concurrent deliveries of the same Svix ID could both pass the check.

Fix: the idempotency row is inserted **before** dispatching the event
using `INSERT ... ON CONFLICT DO NOTHING`. The row's unique index
makes this atomic at the DB level. Zero rows returned = lost the race
= skip dispatch.

### [15] Silence sentinel is no longer user-injectable
**File:** `src/sse/handler.ts`

`POST /:id/message` now explicitly rejects content equal to
`[SILENCE_EVENT]`. The silence path is only reachable via
`POST /:id/silence`, where the sentinel is passed internally without
ever touching user-supplied content.

### [16] Sentry PII scrubbing
**File:** `src/sentry.ts`

- `sendDefaultPii` set to `false` (was `true`)
- `beforeSend` hook removes: request body, cookies, Authorization header,
  query string, and local variable captures from stack frames
- Exception messages are scrubbed of JWT patterns and email addresses
- `tracesSampleRate` reduced to 0.1 in production

---

## Low severity fixes

### [17] Request ID on every request
**Files:** `src/lib/request-id.ts` (new), `src/index.ts`

`requestIdMiddleware` is the first middleware in the stack. It reads
`x-request-id` from the incoming request or generates a new 16-char
hex ID, stores it as `c.get("reqId")`, and echoes it in the
`x-request-id` response header. All log calls in handlers include
`reqId` for correlation.

### [18] SIGTERM graceful drain
**Files:** `src/lib/shutdown.ts` (new), `src/index.ts`

`process.on("SIGTERM")` previously called `process.exit(0)` immediately.
Now it calls `shutdown.drain()`, which:
1. Stops the HTTP server from accepting new connections
2. Rejects incoming requests with 503 during the drain window
3. Waits up to 25 seconds for in-flight tracked promises
4. Closes the Postgres pool cleanly
5. Calls `process.exit(0)`

`unhandledRejection` and `uncaughtException` handlers added to
`src/index.ts` for defence-in-depth.

---

## New files

| File | Purpose |
|---|---|
| `src/lib/verify-clerk-jwt.ts` | Single JWT verification implementation |
| `src/lib/request-id.ts` | Per-request ID middleware |
| `src/lib/rate-limit.ts` | Sliding-window rate limiter with pluggable store |
| `src/lib/shutdown.ts` | Graceful shutdown / in-flight work drain |
| `.env.example` | Updated with all new optional variables |

## Modified files

| File | Changes |
|---|---|
| `src/index.ts` | Graceful shutdown, request ID, lean health, CORS fix, error handlers |
| `src/middleware/auth.ts` | Uses `verify-clerk-jwt.ts`, DB error → 503 |
| `src/sse/handler.ts` | All 9 SSE-layer fixes (see above) |
| `src/routes/sessions.ts` | Abandon teardown, rate limit on create, reqId logging |
| `src/routes/documents.ts` | Magic-byte detection, injection scan, rate limits |
| `src/webhooks/clerk.ts` | Atomic idempotency gate |
| `src/sentry.ts` | PII scrubbing, sendDefaultPii false |
| `src/db/index.ts` | Pool size, max_lifetime, idle_timeout |
| `src/lib/env.ts` | New optional vars: REDIS_URL, INTERNAL_SECRET, DB_POOL_MAX, etc. |
| `src/services/session-controller.ts` | Added `terminate()` static method |
