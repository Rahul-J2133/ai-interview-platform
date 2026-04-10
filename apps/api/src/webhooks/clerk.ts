/**
 * Clerk webhook handler.
 *
 * user.created  → create our internal user record (UUID = PK for entire system)
 * user.updated  → sync email / name / avatar
 * user.deleted  → soft delete
 *
 * Clerk's ID is stored in users.clerk_user_id but NEVER used as a FK.
 */

import { env } from "../lib/env"; // ← loads dotenv
import type { Context } from "hono";
import { Webhook } from "svix";
import { db, users, webhookEvents, userInterviewAggregates } from "@interview/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// ============================================================
// CLERK EVENT PAYLOAD TYPES
// ============================================================

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

// ============================================================
// HANDLER
// ============================================================

export async function handleClerkWebhook(c: Context): Promise<Response> {
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");

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
    logger.warn({ err: String(err) }, "Webhook signature verification failed");
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  // Idempotency — skip duplicate deliveries
  const existing = await db.query.webhookEvents.findFirst({
    where: eq(webhookEvents.svixId, svixId),
  });
  if (existing) {
    logger.debug({ svixId }, "Duplicate webhook, skipping");
    return c.json({ ok: true, duplicate: true });
  }

  try {
    await dispatchEvent(event);

    await db.insert(webhookEvents).values({
      svixId,
      eventType: event.type,
      payload: JSON.parse(body) as Record<string, unknown>,
    });

    return c.json({ ok: true });
  } catch (err) {
    logger.error({ err: String(err), eventType: event.type }, "Webhook processing error");
    return c.json({ error: "Processing failed" }, 500);
  }
}

// ============================================================
// EVENT DISPATCH
// ============================================================

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
      logger.debug({ eventType: (_exhaustive as { type: string }).type }, "Unhandled webhook type");
    }
  }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

function resolvePrimaryEmail(data: ClerkUserData): string | null {
  const primary = data.email_addresses.find(
    (e) => e.id === data.primary_email_address_id
  ) ?? data.email_addresses[0];
  return primary?.email_address ?? null;
}

async function onUserCreated(data: ClerkUserData): Promise<void> {
  const email = resolvePrimaryEmail(data);
  if (!email) {
    logger.warn({ clerkUserId: data.id }, "user.created: no email address found, skipping");
    return;
  }

  // Guard against duplicate webhook delivery (belt + suspenders with svixId check above)
  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, data.id),
    columns: { id: true },
  });
  if (existing) {
    logger.debug({ clerkUserId: data.id }, "User already exists, skipping creation");
    return;
  }

  const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

  // ── CREATE OUR USER — the UUID generated here is the PK for the ENTIRE system ──
  const [newUser] = await db
    .insert(users)
    .values({
      clerkUserId: data.id,
      email,
      fullName,
      avatarUrl: data.image_url,
    })
    .returning({ id: users.id });

  if (!newUser) throw new Error("DB insert returned no rows for user creation");

  // Initialise longitudinal aggregate row
  await db.insert(userInterviewAggregates).values({
    userId: newUser.id,
    totalSessions: 0,
    completedSessions: 0,
  });

  logger.info(
    { internalUserId: newUser.id, clerkUserId: data.id },
    "User provisioned — internal UUID is now the system PK"
  );
}

async function onUserUpdated(data: ClerkUserData): Promise<void> {
  const email = resolvePrimaryEmail(data);
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

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
  // Soft delete — preserve all interview data for audit
  await db
    .update(users)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.clerkUserId, clerkUserId));

  logger.info({ clerkUserId }, "User soft-deleted");
}
