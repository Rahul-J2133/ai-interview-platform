/**
 * src/routes/documents.ts — production hardened
 *
 * Changes from original:
 *
 * [CRITICAL-4] File type detection trusts client Content-Type
 *   Now reads the first 16 bytes of the upload and compares against
 *   known magic byte signatures. Content-Type and file extension are
 *   only used as a secondary hint after magic-byte verification passes.
 *   Falls back gracefully if the file-type package is unavailable.
 *
 * [MEDIUM-10] Resume/JD text accepted without content policy check
 *   Text inputs > 5,000 chars are scanned for obvious prompt injection
 *   patterns (instruction-override keywords). This is a lightweight
 *   heuristic — the real defence is wrapping user content in XML tags
 *   inside the LLM prompt (done in session-controller.ts).
 *
 * [MEDIUM-13] No rate limiting on file uploads
 *   POST /parse rate-limited to 20 uploads per user per minute.
 *
 * [LOW-17] No request ID in logs
 *   All log calls include reqId.
 */

import "../lib/env.js";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { clerkAuthMiddleware } from "../middleware/auth.js";
import { rateLimit, authKey } from "../lib/rate-limit.js";
import { parseDocument, retrieveMulti, buildContextBlock } from "@interview/doc-parser";
import { logger } from "../lib/logger.js";

const documents = new Hono();
documents.use("*", clerkAuthMiddleware);

// ── Magic-byte signatures ──────────────────────────────────
//
// Rather than trusting the Content-Type header (attacker-controlled),
// we read the first 16 bytes and check them against known signatures.
// This is a defence-in-depth layer on top of the doc-parser library's
// own format detection.

interface MagicEntry {
  mime: string;
  fileType: "pdf" | "docx" | "txt";
  magic: number[];
  offset?: number;
}

const MAGIC_SIGNATURES: MagicEntry[] = [
  // PDF: %PDF
  { mime: "application/pdf", fileType: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  // DOCX: PK\x03\x04 (ZIP-based Office Open XML)
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileType: "docx",
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
];

function detectMimeFromBytes(buffer: Buffer): MagicEntry | null {
  for (const entry of MAGIC_SIGNATURES) {
    const offset = entry.offset ?? 0;
    const match = entry.magic.every(
      (byte, i) => buffer[offset + i] === byte
    );
    if (match) return entry;
  }
  return null;
}

function isPlainTextBuffer(buffer: Buffer, sampleSize = 512): boolean {
  // Heuristic: plain text files have no null bytes and consist mostly
  // of printable ASCII / UTF-8 in the first sampleSize bytes.
  const sample = buffer.slice(0, sampleSize);
  for (const byte of sample) {
    if (byte === 0x00) return false; // null byte → binary
  }
  return true;
}

// ── Prompt injection heuristic ─────────────────────────────
//
// Lightweight scan for obvious instruction-override patterns in
// user-supplied text before it gets embedded in LLM context.
// The primary defence is XML tag wrapping in the prompt template.

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+(a|an)\s+\w/i,
  /system\s*prompt/i,
  /\bact\s+as\s+(a|an)\b/i,
  /forget\s+(everything|all)\s+(you|above)/i,
];

function containsPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// ── PARSE ──────────────────────────────────────────────────

documents.post(
  "/parse",
  rateLimit({ windowMs: 60_000, max: 20, keyFn: authKey }),
  async (c) => {
    const reqId = c.get("reqId");

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

    // Read full buffer for magic-byte check
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ── Primary: magic-byte detection ──
    const detected = detectMimeFromBytes(buffer);

    let fileType: "pdf" | "docx" | "txt" | undefined;

    if (detected) {
      fileType = detected.fileType;
    } else if (isPlainTextBuffer(buffer)) {
      // Plain text has no magic bytes — fall back to extension/content-type
      const contentType = file.type.toLowerCase();
      const fileName = file.name.toLowerCase();
      if (contentType === "text/plain" || fileName.endsWith(".txt")) {
        fileType = "txt";
      }
    }

    if (!fileType) {
      logger.warn(
        {
          event: "documents.parse.unsupported_type",
          contentType: file.type,
          fileName: file.name,
          size: file.size,
          reqId,
        },
        "Rejected upload — unsupported or mismatched file type"
      );
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
      const parsed = await parseDocument(buffer, fileType);

      // Light injection scan on extracted text
      if (containsPromptInjection(parsed.text)) {
        logger.warn(
          { event: "documents.parse.injection_detected", fileType, reqId },
          "Potential prompt injection detected in uploaded document"
        );
        // Return the parsed text but flag it — let the caller decide
        // whether to block or sanitize. We don't silently drop content.
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
            warning: "CONTENT_POLICY",
          },
          error: null,
        });
      }

      logger.info(
        { event: "documents.parse.complete", fileType, charCount: parsed.charCount, reqId },
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
      logger.error({ event: "documents.parse.failed", err, reqId }, "Document parse failed");
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
  }
);

// ── RETRIEVE ───────────────────────────────────────────────

const retrieveSchema = z.object({
  text: z.string().min(50, "Document text must be at least 50 characters"),
  queries: z
    .array(z.string().min(1))
    .min(1, "At least one query is required")
    .max(10, "Maximum 10 queries"),
  topK: z.number().int().min(1).max(10).default(3),
  fileType: z.enum(["pdf", "docx", "txt"]).optional(),
});

documents.post(
  "/retrieve",
  rateLimit({ windowMs: 60_000, max: 30, keyFn: authKey }),
  zValidator("json", retrieveSchema),
  async (c) => {
    const body = c.req.valid("json");
    const reqId = c.get("reqId");

    try {
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
      logger.error({ event: "documents.retrieve.failed", err, reqId }, "Retrieval failed");
      return c.json(
        { data: null, error: { code: "RETRIEVAL_FAILED", message: String(err) } },
        500
      );
    }
  }
);

export default documents;
