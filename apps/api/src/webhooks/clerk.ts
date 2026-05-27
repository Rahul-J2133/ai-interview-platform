/**
 * src/webhooks/clerk.ts — production hardened
 *
 * Changes from original:
 *
 * [MEDIUM-14] Webhook idempotency check is non-atomic (TOCTOU)
 *   The original did a SELECT to check for duplicates, then INSERT
 *   after dispatching the event. Two concurrent deliveries of the same
 *   svix-id could both pass the SELECT check before either completes
 *   the INSERT, causing duplicate user creation.
 *
 *   Fix: INSERT ... ON CONFLICT DO NOTHING is atomic. The row is
 *   inserted BEFORE dispatching the event. If the insert is a no-op
 *   (duplicate), we skip dispatch immediately. If two concurrent
 *   deliveries race, exactly one wins the insert and dispatches;
 *   the other gets 0 rows back and returns early.
 *
 * [LOW-17] No request ID in logs
 *   reqId passed through for correlation.
 */

import { env } from "../lib/env.js";
import type { Context } from "hono";
import { Webhook } from "svix";
import { db, users, webhookEvents, userInterviewAggregates } from "../db/index.js";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

// ── Clerk event types ──────────────────────────────────────

interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

interface ClerkUserData {
  id: string;
  email_addresses: ClerkEmailAddress[];
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
}

type ClerkWebhookEvent =
  | { type: "user.created"; data: ClerkUserData }
  | { type: "user.updated"; data: ClerkUserData }
  | { type: "user.deleted"; data: { id: string; deleted: boolean } };

// ── Handler ────────────────────────────────────────────────

export async function handleClerkWebhook(c: Context): Promise<Response> {
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");
  const reqId = c.get("reqId");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ error: "Missing svix headers" }, 400);
  }

  const body = await c.req.text();

  let event: ClerkWebhookEvent;
  try {
    const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch (err) {
    logger.warn(
      { event: "webhook.signature_invalid", err: String(err), reqId },
      "Webhook signature verification failed"
    );
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  // ── Atomic idempotency gate ────────────────────────────
  //
  // INSERT the idempotency row FIRST (before dispatching the event).
  // ON CONFLICT DO NOTHING means if a row with this svix_id already
  // exists, the insert is skipped and we get 0 rows back → early return.
  //
  // This is safe against concurrent deliveries because the INSERT
  // (with a unique index on svix_id) is atomic at the DB level:
  // exactly one concurrent INSERT wins; all others get 0 rows back.

  let inserted: Array<{ id: string }>;
  try {
    inserted = await db
      .insert(webhookEvents)
      .values({
        svixId,
        eventType: event.type,
        payload: JSON.parse(body) as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
  } catch (err) {
    logger.error(
      { event: "webhook.idempotency_insert_failed", err: String(err), svixId, reqId },
      "Failed to insert webhook idempotency row"
    );
    return c.json({ error: "Processing failed" }, 500);
  }

  if (inserted.length === 0) {
    // Lost the race — another delivery already processed this event
    logger.debug({ event: "webhook.duplicate", svixId, reqId }, "Duplicate webhook, skipping");
    return c.json({ ok: true, duplicate: true });
  }

  // We won the race — dispatch the event
  try {
    await dispatchEvent(event);
    return c.json({ ok: true });
  } catch (err) {
    logger.error(
      { event: "webhook.dispatch_failed", err: String(err), eventType: event.type, reqId },
      "Webhook dispatch error"
    );
    // Note: we intentionally do NOT delete the idempotency row on failure.
    // Clerk will retry the delivery with the same svix-id, but we've
    // already inserted the row so the retry will be skipped above.
    // If you want retries to re-run the event, delete the row here.
    // For now, the safer default is to not reprocess (avoids duplicate user creation).
    return c.json({ error: "Processing failed" }, 500);
  }
}

// ── Dispatch ───────────────────────────────────────────────

async function dispatchEvent(event: ClerkWebhookEvent): Promise<void> {
  switch (event.type) {
    case "user.created":
      await onUserCreated(event.data);
      break;
    case "user.updated":
      await onUserUpdated(event.data);
      break;
    case "user.deleted":
      await onUserDeleted(event.data.id);
      break;
    default: {
      const _exhaustive: never = event;
      logger.debug(
        { eventType: (_exhaustive as { type: string }).type },
        "Unhandled webhook type"
      );
    }
  }
}

// ── Event handlers ─────────────────────────────────────────

function resolvePrimaryEmail(data: ClerkUserData): string | null {
  const primary =
    data.email_addresses.find((e) => e.id === data.primary_email_address_id) ??
    data.email_addresses[0];
  return primary?.email_address ?? null;
}

async function onUserCreated(data: ClerkUserData): Promise<void> {
  const email = resolvePrimaryEmail(data);
  if (!email) {
    logger.warn(
      { clerkUserId: data.id },
      "user.created: no email address found, skipping"
    );
    return;
  }

  const fullName =
    [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

  const [newUser] = await db
    .insert(users)
    .values({
      clerkUserId: data.id,
      email,
      fullName,
      avatarUrl: data.image_url,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });

  if (!newUser) {
    // Row already existed (e.g. prior webhook delivery that succeeded
    // but returned a 5xx before the idempotency row was written)
    logger.debug({ clerkUserId: data.id }, "User already exists, skipping creation");
    return;
  }

  await db.insert(userInterviewAggregates).values({
    userId: newUser.id,
    totalSessions: 0,
    completedSessions: 0,
  });

  logger.info(
    { internalUserId: newUser.id, clerkUserId: data.id },
    "User provisioned"
  );
}

async function onUserUpdated(data: ClerkUserData): Promise<void> {
  const email = resolvePrimaryEmail(data);
  const fullName =
    [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

  await db
    .update(users)
    .set({
      ...(email ? { email } : {}),
      fullName,
      avatarUrl: data.image_url,
      updatedAt: new Date(),
    })
    .where(eq(users.clerkUserId, data.id));

  logger.info({ clerkUserId: data.id }, "User synced from Clerk update");
}

async function onUserDeleted(clerkUserId: string): Promise<void> {
  await db
    .update(users)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.clerkUserId, clerkUserId));

  logger.info({ clerkUserId }, "User soft-deleted");
}
