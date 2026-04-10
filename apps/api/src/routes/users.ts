import "../lib/env";

import { Hono } from "hono";
import { db, users, userInterviewAggregates } from "@interview/db";
import { eq } from "drizzle-orm";
import { clerkAuthMiddleware } from "../middleware/auth";

const usersRouter = new Hono();
usersRouter.use("*", clerkAuthMiddleware);

usersRouter.get("/me", async (c) => {
  const auth = c.get("auth");

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.internalUserId),
    columns: { id: true, email: true, fullName: true, avatarUrl: true, createdAt: true },
  });

  if (!user) {
    return c.json({ data: null, error: { code: "NOT_FOUND", message: "User not found" } }, 404);
  }

  const aggregate = await db.query.userInterviewAggregates.findFirst({
    where: eq(userInterviewAggregates.userId, auth.internalUserId),
  });

  return c.json({
    data: {
      ...user,
      stats: aggregate
        ? {
            totalSessions: aggregate.totalSessions,
            completedSessions: aggregate.completedSessions,
            avgOverallScore: aggregate.avgOverallScore,
            bestHireSignal: aggregate.bestHireSignal,
            lastSessionAt: aggregate.lastSessionAt,
            crossRoundMetaScore: aggregate.crossRoundMetaScore,
          }
        : null,
    },
    error: null,
  });
});

export default usersRouter;
