# AI Interview Platform

A production-grade platform that simulates real job interviews with AI. Three interview types (System Design, Behavioral, Domain Knowledge) — each powered by a dedicated XState v5 state machine, multi-expert Anthropic AI agents, and real-time WebSocket communication.

---

## Architecture Overview

```
apps/
  web/          Next.js 14 (App Router) — Clerk auth on the client
  api/          Hono + Node.js — REST + WebSocket server

packages/
  shared-types/ TypeScript types shared across all packages
  db/           Drizzle ORM schema + Postgres client
  state-machines/ XState v5 machines for all 3 interview types
  ai-engine/    Anthropic SDK wrapper — multi-expert agent pattern
```

### Identity Architecture — The Single Most Important Design Decision

```
Clerk (Auth Layer)          Our System
─────────────────           ─────────────────────────────────────────
clerk_user_id  ──────────→  users.clerk_user_id   (stored, never FK)
                            users.id (UUID)        ← PRIMARY KEY
                                                         │
                                            ┌────────────┘
                                            ↓
                                    interview_sessions.user_id
                                    transcript_messages (via session)
                                    dimension_scores (via session)
                                    user_interview_aggregates.user_id
```

**Every table in the system uses `users.id` (our UUID) as the foreign key.**
Clerk's ID is stored in `users.clerk_user_id` for two purposes only:
1. Webhook deduplication (`user.created` → create our user record)
2. JWT verification (map `sub` claim → our internal user on each request)

After that mapping, Clerk's ID never touches the system again.

### State Machine Architecture

Three independent XState v5 machines with a shared shell:

```
InterviewSessionController
├── systemDesignMachine    (8 phases × sub-states)
├── behavioralMachine      (7 phases × sub-states)
└── domainKnowledgeMachine (8 phases × sub-states)

Shared nodes (extracted):
  PARSING_INPUTS → QUALITY_GATE → HIRE_SIGNAL_CALC
  EVIDENCE_MAPPING → REPORT_GENERATED → TERMINAL_COMPLETED
  SESSION_CLOSING → CROSS_ROUND_META_SCORE
```

All state machine refinements from the spec are implemented:
- **Silence nudge as explicit state** (SILENCE_NUDGE_ISSUED)
- **Phase timeout as parallel timer** (XState `after:` transitions)
- **Per-probe loop** (PROBE_ISSUE → PROBE_RESPONSE_EVAL → loop)
- **Scale stress test** (separate from tradeoff challenge)
- **Attribution detection** as own state (ATTRIBUTION_CHECK)
- **Result depth probe** before consuming probe budget
- **Story existence check** with fallback prompt
- **Auth flags converge on scoring** (soft signals, not gates)
- **Tutorial vs production classification** (explicit state)
- **Adjacent domain test** (IDK_HANDLING → ADJACENT_DOMAIN_TEST)
- **D2 time management redirect** (D2_REDIRECT state)
- **Reasoning depth evaluation** (not binary pass/fail)
- **Coachability as multiplier** (not additive to score)
- **Cross-round meta score = minimum** across all 3 types (not average)

### Multi-Expert AI Pattern

```
Planner    (claude-sonnet)  — Pre-session plan & question generation
Interviewer (claude-opus)   — Live question delivery, probes, redirects
Evaluator  (claude-sonnet)  — Real-time answer evaluation & signal extraction
Scorer     (claude-opus)    — Final dimension scoring & report generation
```

---

## Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Clerk account (free tier works)
- Anthropic API key

---

## Local Development Setup

### 1. Clone and install

```bash
git clone <repo>
cd ai-interview-platform
npm install
```

### 2. Start infrastructure

```bash
docker compose up -d
# Starts Postgres on :5432 and Redis on :6379
```

### 3. Configure environment

```bash
cp .env.example apps/api/.env
cp .env.example apps/web/.env.local
```

Edit both files with your actual keys:

```env
# Both files
DATABASE_URL="postgresql://postgres:password@localhost:5432/interview_platform"
ANTHROPIC_API_KEY="sk-ant-..."

# API only
CLERK_DOMAIN="your-app.clerk.accounts.dev"
CLERK_WEBHOOK_SECRET="whsec_..."

# Web only
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
```

### 4. Run database migrations

```bash
cd packages/db
npm run db:push    # Push schema to Postgres (dev)
# OR
npm run db:migrate # Run migration files (production)
```

### 5. Configure Clerk webhook

In your Clerk dashboard → Webhooks → Add endpoint:
- URL: `http://localhost:4000/webhooks/clerk`
- Events: `user.created`, `user.updated`, `user.deleted`
- Copy the signing secret to `CLERK_WEBHOOK_SECRET`

Use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) to expose localhost for webhook delivery during development.

### 6. Start development servers

```bash
# From root
npm run dev

# Or individually:
cd apps/api && npm run dev    # API on :4000, WS on :4001
cd apps/web && npm run dev    # Next.js on :3000
```

---

## Database Schema

```sql
users                    -- Our UUID is PK. clerk_user_id is stored but never FK.
interview_sessions       -- FK: users.id (never clerk_user_id)
transcript_messages      -- FK: interview_sessions.id
dimension_scores         -- FK: interview_sessions.id (normalized for analytics)
user_interview_aggregates -- FK: users.id (longitudinal tracking)
webhook_events           -- Clerk webhook idempotency log
```

---

## API Reference

### Authentication

All `/api/v1/*` routes require:
```
Authorization: Bearer <clerk_jwt>
```

The backend verifies the JWT, extracts `sub` (Clerk user ID), looks up `users.id` (our UUID), and uses that for all DB operations.

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/sessions` | Create interview session |
| `GET` | `/api/v1/sessions` | List user's sessions |
| `GET` | `/api/v1/sessions/:id` | Get session details |
| `GET` | `/api/v1/sessions/:id/transcript` | Full transcript |
| `GET` | `/api/v1/sessions/:id/report` | Final report |
| `POST` | `/api/v1/sessions/:id/abandon` | Abandon session |

### WebSocket

Connect to `ws://localhost:4001/ws?sessionId=<id>&token=<clerk_jwt>`

**Client → Server:**
```json
{ "type": "candidate_message", "payload": { "content": "My answer..." } }
{ "type": "silence_event" }
{ "type": "ping" }
```

**Server → Client:**
```json
{ "type": "interviewer_message", "payload": { "content": "...", "isNudge": false } }
{ "type": "session_state_update", "payload": { "phase": 2, "stateName": "CLARIFYING" } }
{ "type": "session_complete", "payload": {} }
{ "type": "error", "payload": { "message": "..." } }
```

---

## Production Deployment

### Environment-specific changes needed

1. **Actor registry** — Replace the in-memory `Map` in `session-controller.ts` with Redis-backed actor snapshot storage for horizontal scaling:
   ```ts
   // Replace:
   const actorRegistry = new Map<string, AnyActor>();
   // With: Redis + XState snapshot serialization
   ```

2. **WebSocket** — For multi-instance deployments, use Redis pub/sub to route WS messages to the correct server instance (e.g. Socket.io Redis adapter pattern).

3. **JWT verification** — The WS token verification in `ws/server.ts` uses a fast-path decode. Swap for full JWKS signature verification (same as `middleware/auth.ts`) in production.

4. **BullMQ** — Heavy async work (report generation, scoring) can be offloaded to BullMQ workers backed by Redis. The infrastructure is already in `docker-compose.yml`.

### Deployment checklist

- [ ] `DATABASE_URL` points to production Postgres with SSL
- [ ] `CLERK_WEBHOOK_SECRET` matches production webhook endpoint
- [ ] `ANTHROPIC_API_KEY` has sufficient quota for concurrent sessions
- [ ] Redis available for actor registry and WS routing
- [ ] Postgres connection pool sized for expected concurrency (20 connections per API instance)
- [ ] `NODE_ENV=production` to disable dev logging and HMR
- [ ] Health check endpoint `/health` registered with load balancer

---

## Cross-Round Meta Score

When a candidate completes all three interview types, the Domain Knowledge Phase 7 computes a `CrossRoundMetaScore`:

```ts
finalHireSignal = min(sdScore, behavioralScore, domainScore)
// NOT average — the weakest link determines the overall signal
```

This is stored in `user_interview_aggregates.cross_round_meta_score` and surfaced in the report UI.

---

## Adding a New Interview Type

1. Create `packages/state-machines/src/<type>/machine.ts` following the same pattern
2. Add the type to `interviewTypeEnum` in `packages/db/src/schema.ts`
3. Run `npm run db:migrate` to update the schema
4. Add a plan generator in `packages/ai-engine/src/index.ts`
5. Register the new machine in `apps/api/src/services/session-controller.ts`
6. Add phase labels in `apps/web/src/app/interview/[id]/interview-client.tsx`
