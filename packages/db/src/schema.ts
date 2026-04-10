import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  real,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  SessionMetadata,
  InterviewReport,
  SystemDesignContext,
  BehavioralContext,
  DomainKnowledgeContext,
  MessageMetadata,
} from "@interview/shared-types";

// ============================================================
// ENUMS — must match the union literals in shared-types exactly
// ============================================================

export const interviewTypeEnum = pgEnum("interview_type", [
  "system_design",
  "behavioral",
  "domain_knowledge",
]);

export const interviewTierEnum = pgEnum("interview_tier", ["T1", "T2", "T3"]);

export const interviewLevelEnum = pgEnum("interview_level", [
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
]);

export const sessionStatusEnum = pgEnum("session_status", [
  "initializing",
  "ready",
  "active",
  "paused",
  "completed",
  "abandoned",
]);

export const hireSignalEnum = pgEnum("hire_signal", [
  "strong_hire",
  "hire",
  "no_hire",
  "strong_no_hire",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "interviewer",
  "candidate",
  "system",
]);

export const messageTypeEnum = pgEnum("message_type", [
  "question",
  "answer",
  "follow_up",
  "probe",
  "redirect",
  "nudge",
  "clarification",
  "summary",
  "system_event",
]);

// ============================================================
// USERS
// Our internal UUID is the ONE primary key for the entire system.
// clerk_user_id is stored only for:
//   1. Webhook deduplication (user.created)
//   2. Auth token verification (JWT sub → users.id lookup)
// It is NEVER used as a foreign key in any other table.
// ============================================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clerkUserIdUnique: uniqueIndex("users_clerk_user_id_unique").on(table.clerkUserId),
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
  })
);

// ============================================================
// INTERVIEW SESSIONS
// ============================================================

export const interviewSessions = pgTable(
  "interview_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: interviewTypeEnum("type").notNull(),
    tier: interviewTierEnum("tier").notNull().default("T2"),
    level: interviewLevelEnum("level").notNull().default("mid"),
    role: text("role").notNull(),
    jdText: text("jd_text"),
    resumeText: text("resume_text"),
    status: sessionStatusEnum("status").notNull().default("initializing"),
    currentPhase: integer("current_phase").notNull().default(0),
    hireSignal: hireSignalEnum("hire_signal"),
    overallScore: real("overall_score"),
    // Full report JSON — stored as JSONB for fast retrieval.
    // Note: Date fields inside InterviewReport are serialized as ISO strings
    // by JSON.stringify and must be re-hydrated with new Date() on read.
    report: jsonb("report").$type<InterviewReport>(),
    // Type-specific machine context snapshots
    systemDesignCtx: jsonb("system_design_ctx").$type<SystemDesignContext>(),
    behavioralCtx: jsonb("behavioral_ctx").$type<BehavioralContext>(),
    domainKnowledgeCtx: jsonb("domain_knowledge_ctx").$type<DomainKnowledgeContext>(),
    // Aggregate session stats
    metadata: jsonb("metadata")
      .$type<SessionMetadata>()
      .notNull()
      .$defaultFn(() => ({
        durationSeconds: 0,
        totalExchanges: 0,
        silenceEvents: 0,
        probeCount: 0,
        redirectCount: 0,
      })),
    // XState snapshot for pause/resume
    stateMachineSnapshot: jsonb("state_machine_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("sessions_user_id_idx").on(table.userId),
    statusIdx: index("sessions_status_idx").on(table.status),
    typeIdx: index("sessions_type_idx").on(table.type),
    createdAtIdx: index("sessions_created_at_idx").on(table.createdAt),
    scoreCheck: check(
      "overall_score_range",
      sql`${table.overallScore} IS NULL OR (${table.overallScore} >= 0 AND ${table.overallScore} <= 1)`
    ),
  })
);

// ============================================================
// TRANSCRIPT MESSAGES
// ============================================================

export const transcriptMessages = pgTable(
  "transcript_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),
    sequenceIndex: integer("sequence_index").notNull(),
    role: messageRoleEnum("role").notNull(),
    type: messageTypeEnum("type").notNull(),
    content: text("content").notNull(),
    phase: integer("phase").notNull(),
    stateName: text("state_name").notNull(),
    metadata: jsonb("metadata").$type<MessageMetadata>().notNull().$defaultFn(() => ({})),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index("messages_session_id_idx").on(table.sessionId),
    sessionSequenceUnique: uniqueIndex("messages_session_sequence_unique").on(
      table.sessionId,
      table.sequenceIndex
    ),
    phaseIdx: index("messages_phase_idx").on(table.phase),
  })
);

// ============================================================
// DIMENSION SCORES — normalized for analytics queries
// ============================================================

export const dimensionScores = pgTable(
  "dimension_scores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    score: real("score").notNull(),
    evidence: text("evidence").notNull(),
    transcriptIndices: jsonb("transcript_indices")
      .$type<number[]>()
      .notNull()
      .$defaultFn(() => []),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index("dim_scores_session_id_idx").on(table.sessionId),
    scoreCheck: check(
      "dim_score_range",
      sql`${table.score} >= 0 AND ${table.score} <= 1`
    ),
  })
);

// ============================================================
// WEBHOOK EVENTS — Clerk webhook idempotency log
// ============================================================

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    svixId: text("svix_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    svixIdUnique: uniqueIndex("webhook_events_svix_id_unique").on(table.svixId),
  })
);

// ============================================================
// USER INTERVIEW AGGREGATES — longitudinal tracking
// ============================================================

export const userInterviewAggregates = pgTable(
  "user_interview_aggregates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    totalSessions: integer("total_sessions").notNull().default(0),
    completedSessions: integer("completed_sessions").notNull().default(0),
    avgOverallScore: real("avg_overall_score"),
    bestHireSignal: hireSignalEnum("best_hire_signal"),
    lastSessionAt: timestamp("last_session_at", { withTimezone: true }),
    crossRoundMetaScore: jsonb("cross_round_meta_score"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdUnique: uniqueIndex("user_aggregates_user_id_unique").on(table.userId),
  })
);

// ============================================================
// RELATIONS
// ============================================================

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(interviewSessions),
  aggregate: one(userInterviewAggregates, {
    fields: [users.id],
    references: [userInterviewAggregates.userId],
  }),
}));

export const interviewSessionsRelations = relations(
  interviewSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [interviewSessions.userId],
      references: [users.id],
    }),
    messages: many(transcriptMessages),
    dimensionScores: many(dimensionScores),
  })
);

export const transcriptMessagesRelations = relations(
  transcriptMessages,
  ({ one }) => ({
    session: one(interviewSessions, {
      fields: [transcriptMessages.sessionId],
      references: [interviewSessions.id],
    }),
  })
);

export const dimensionScoresRelations = relations(dimensionScores, ({ one }) => ({
  session: one(interviewSessions, {
    fields: [dimensionScores.sessionId],
    references: [interviewSessions.id],
  }),
}));

export const userInterviewAggregatesRelations = relations(
  userInterviewAggregates,
  ({ one }) => ({
    user: one(users, {
      fields: [userInterviewAggregates.userId],
      references: [users.id],
    }),
  })
);

// ============================================================
// INFERRED TYPES for use in application code
// ============================================================

export type DbUser = typeof users.$inferSelect;
export type NewDbUser = typeof users.$inferInsert;
export type DbInterviewSession = typeof interviewSessions.$inferSelect;
export type NewDbInterviewSession = typeof interviewSessions.$inferInsert;
export type DbTranscriptMessage = typeof transcriptMessages.$inferSelect;
export type NewDbTranscriptMessage = typeof transcriptMessages.$inferInsert;
export type DbDimensionScore = typeof dimensionScores.$inferSelect;
export type NewDbDimensionScore = typeof dimensionScores.$inferInsert;
export type DbWebhookEvent = typeof webhookEvents.$inferSelect;
export type NewDbWebhookEvent = typeof webhookEvents.$inferInsert;
