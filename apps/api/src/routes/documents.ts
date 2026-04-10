/**
 * Document upload + text extraction route.
 *
 * POST /api/v1/documents/parse
 *   Accepts multipart/form-data with field "file" (PDF, DOCX, or TXT).
 *   Returns extracted text and document metadata.
 *   The extracted text can then be passed as resumeText / jdText
 *   when creating a session.
 *
 * POST /api/v1/documents/retrieve
 *   Accepts { text, queries[] } JSON body.
 *   Returns top-k relevant passages using BM25 retrieval.
 *   Used by the frontend to show relevant context from uploaded docs.
 */

import "../lib/env";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
// const zValidator = require("@hono/zod-validator");
import { z } from "zod";
import { clerkAuthMiddleware } from "../middleware/auth";
import { parseDocument, retrieveMulti, buildContextBlock } from "@interview/doc-parser";
import { logger } from "../lib/logger";

const documents = new Hono();

documents.use("*", clerkAuthMiddleware);

// ── PARSE ─────────────────────────────────────────────────

documents.post("/parse", async (c) => {
  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    return c.json(
      { data: null, error: { code: "INVALID_FORM", message: "Expected multipart/form-data" } },
      400
    );
  }

  const fileEntry = body.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return c.json(
      { data: null, error: { code: "MISSING_FILE", message: "Field 'file' is required" } },
      400
    );
  }

  const file = fileEntry as File;
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_BYTES) {
    return c.json(
      { data: null, error: { code: "FILE_TOO_LARGE", message: "Maximum file size is 10 MB" } },
      413
    );
  }

  // Detect type from content-type header or filename extension
  const contentType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  let fileType: "pdf" | "docx" | "txt" | undefined;
  if (contentType === "application/pdf" || fileName.endsWith(".pdf")) {
    fileType = "pdf";
  } else if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fileName.endsWith(".docx")
  ) {
    fileType = "docx";
  } else if (contentType === "text/plain" || fileName.endsWith(".txt")) {
    fileType = "txt";
  } else {
    return c.json(
      {
        data: null,
        error: {
          code: "UNSUPPORTED_TYPE",
          message: "Only PDF, DOCX, and TXT files are supported",
        },
      },
      415
    );
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const parsed = await parseDocument(buffer, fileType);

    logger.info(
      { fileType, charCount: parsed.charCount, sections: parsed.meta.sections.length },
      "Document parsed"
    );

    return c.json({
      data: {
        text: parsed.text,
        charCount: parsed.charCount,
        fileType: parsed.fileType,
        meta: {
          sections: parsed.meta.sections,
          skills: parsed.meta.skills,
          yearsExperience: parsed.meta.yearsExperience,
          isResume: parsed.meta.isResume,
          chunkCount: parsed.chunks.length,
        },
      },
      error: null,
    });
  } catch (err) {
    logger.error({ err }, "Document parse failed");
    return c.json(
      {
        data: null,
        error: {
          code: "PARSE_FAILED",
          message: String(err).replace(/^Error:\s*/i, ""),
        },
      },
      422
    );
  }
});

// ── RETRIEVE ──────────────────────────────────────────────

const retrieveSchema = z.object({
  text: z.string().min(50, "Document text must be at least 50 characters"),
  queries: z
    .array(z.string().min(1))
    .min(1, "At least one query is required")
    .max(10, "Maximum 10 queries"),
  topK: z.number().int().min(1).max(10).default(3),
  fileType: z.enum(["pdf", "docx", "txt"]).optional(),
});

documents.post("/retrieve", zValidator("json", retrieveSchema), async (c) => {
  const body = c.req.valid("json");

  try {
    // Re-parse the text to build chunk index
    const buffer = Buffer.from(body.text, "utf-8");
    const parsed = await parseDocument(buffer, "txt");

    const results = retrieveMulti(parsed, body.queries, body.topK);
    const contextBlock = buildContextBlock(results);

    return c.json({
      data: {
        results: results.map((r) => ({
          text: r.chunk.text,
          score: r.score,
          query: r.query,
          chunkIndex: r.chunk.index,
        })),
        contextBlock,
        totalChunks: parsed.chunks.length,
      },
      error: null,
    });
  } catch (err) {
    logger.error({ err }, "Retrieval failed");
    return c.json(
      { data: null, error: { code: "RETRIEVAL_FAILED", message: String(err) } },
      500
    );
  }
});

export default documents;
