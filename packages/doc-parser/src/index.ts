/**
 * @interview/doc-parser
 *
 * PDF and DOCX text extraction with vectorless retrieval.
 *
 * "Vectorless retrieval" here means:
 *   - No embeddings, no vector DB, no external services
 *   - Documents are chunked into overlapping passages
 *   - Queries are matched via TF-IDF-style term scoring (BM25 approximation)
 *   - Results are ranked by score and returned as plain text
 *
 * This is sufficient for resume/JD context injection because:
 *   1. Documents are small (< 10 pages typically)
 *   2. We only need the top-k relevant passages, not semantic search
 *   3. Zero latency overhead, no API calls, no infrastructure
 */

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { getPath } from "pdf-parse/worker";

PDFParse.setWorker(getPath());
// ============================================================
// PUBLIC TYPES
// ============================================================

export interface ParsedDocument {
  /** Raw extracted text, normalized */
  text: string;
  /** Document split into overlapping chunks for retrieval */
  chunks: TextChunk[];
  /** Metadata extracted from the document */
  meta: DocumentMeta;
  /** Source file type */
  fileType: "pdf" | "docx" | "txt";
  /** Total character count of extracted text */
  charCount: number;
}

export interface TextChunk {
  /** Zero-based chunk index */
  index: number;
  /** The chunk text */
  text: string;
  /** Approximate character offset in original document */
  offset: number;
  /** TF map: term → count within this chunk */
  termFrequency: Map<string, number>;
  /** Total token count in chunk */
  tokenCount: number;
}

export interface DocumentMeta {
  /** Detected sections / headings */
  sections: string[];
  /** Named entities detected heuristically */
  skills: string[];
  /** Years of experience (heuristic, may be null) */
  yearsExperience: number | null;
  /** Whether the document looks like a resume */
  isResume: boolean;
}

export interface RetrievalResult {
  chunk: TextChunk;
  score: number;
  query: string;
}

// ============================================================
// CHUNKING CONFIG
// ============================================================

const CHUNK_SIZE_CHARS = 600;   // target characters per chunk
const CHUNK_OVERLAP_CHARS = 150; // overlap to preserve sentence context
const MIN_CHUNK_CHARS = 80;     // discard chunks shorter than this

// ============================================================
// TEXT EXTRACTION
// ============================================================

/**
 * Extract text from a PDF Buffer.
 * Uses pdf-parse which handles standard PDFs including those with
 * embedded fonts. Scanned PDFs (image-only) will return empty text.
 */

export async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return normalizeText(result.text);
  } catch (err) {
    throw new Error(`PDF extraction failed: ${String(err)}`);
  }
}

/**
 * Extract text from a DOCX Buffer using mammoth.
 * mammoth converts to markdown-flavoured plain text, preserving
 * heading structure which we use for section detection.
 */
export async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    if (result.messages.length > 0) {
      // Log warnings but don't fail — partial extraction is fine
      result.messages.forEach((m) => {
        if (m.type === "error") {
          console.warn("[doc-parser] DOCX warning:", m.message);
        }
      });
    }
    return normalizeText(result.value);
  } catch (err) {
    throw new Error(`DOCX extraction failed: ${String(err)}`);
  }
}

/**
 * Extract plain text — trivial passthrough with normalization.
 */
export function extractTxt(buffer: Buffer): string {
  return normalizeText(buffer.toString("utf-8"));
}

// ============================================================
// FULL PARSE PIPELINE
// ============================================================

/**
 * Parse a document buffer into a structured ParsedDocument.
 * Detects file type from the buffer magic bytes if not provided.
 */
export async function parseDocument(
  buffer: Buffer,
  fileType?: "pdf" | "docx" | "txt"
): Promise<ParsedDocument> {
  const detected = fileType ?? detectFileType(buffer);

  let rawText: string;
  switch (detected) {
    case "pdf":
      rawText = await extractPdf(buffer);
      break;
    case "docx":
      rawText = await extractDocx(buffer);
      break;
    case "txt":
      rawText = extractTxt(buffer);
      break;
    default: {
      const _exhaustive: never = detected;
      throw new Error(`Unsupported file type: ${String(_exhaustive)}`);
    }
  }

  if (!rawText.trim()) {
    throw new Error(
      "No text could be extracted from the document. " +
      "If this is a scanned PDF, OCR is required."
    );
  }

  const chunks = buildChunks(rawText);
  const meta = extractMeta(rawText);

  return {
    text: rawText,
    chunks,
    meta,
    fileType: detected,
    charCount: rawText.length,
  };
}

// ============================================================
// FILE TYPE DETECTION (magic bytes)
// ============================================================

function detectFileType(buffer: Buffer): "pdf" | "docx" | "txt" {
  if (buffer.length < 4) return "txt";

  // PDF: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "pdf";
  }

  // DOCX (ZIP): PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return "docx";
  }

  return "txt";
}

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeText(raw: string): string {
  return raw
    // Collapse runs of whitespace/newlines to single newline
    .replace(/[ \t]+/g, " ")
    // Collapse 3+ consecutive newlines to 2
    .replace(/\n{3,}/g, "\n\n")
    // Remove null bytes and other control characters except tab/newline
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

// ============================================================
// CHUNKING
// ============================================================

function buildChunks(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;

  // Split on paragraph breaks first for cleaner chunks
  const paragraphs = text.split(/\n\n+/);
  let buffer = "";
  let bufferOffset = 0;

  for (const para of paragraphs) {
    const paraWithBreak = para + "\n\n";

    if (buffer.length + paraWithBreak.length > CHUNK_SIZE_CHARS && buffer.length > 0) {
      // Emit current buffer as a chunk
      if (buffer.length >= MIN_CHUNK_CHARS) {
        chunks.push(makeChunk(index++, buffer.trim(), bufferOffset));
      }

      // Keep the overlap portion for the next chunk
      const overlap = buffer.slice(Math.max(0, buffer.length - CHUNK_OVERLAP_CHARS));
      bufferOffset = bufferOffset + buffer.length - overlap.length;
      buffer = overlap + paraWithBreak;
    } else {
      if (buffer.length === 0) bufferOffset = offset;
      buffer += paraWithBreak;
    }

    offset += paraWithBreak.length;
  }

  // Emit remaining buffer
  if (buffer.trim().length >= MIN_CHUNK_CHARS) {
    chunks.push(makeChunk(index, buffer.trim(), bufferOffset));
  }

  return chunks;
}

function makeChunk(index: number, text: string, offset: number): TextChunk {
  const tokens = tokenize(text);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  return {
    index,
    text,
    offset,
    termFrequency,
    tokenCount: tokens.length,
  };
}

// ============================================================
// TOKENIZER — simple, no external deps
// ============================================================

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "is", "was", "are", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "i", "me", "my", "we", "our", "you", "your", "it", "its",
  "this", "that", "these", "those", "as", "if", "then", "than",
  "so", "because", "when", "while", "which", "who", "what",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ============================================================
// VECTORLESS RETRIEVAL — BM25 approximation
// ============================================================

/**
 * BM25 hyperparameters
 * k1 = term frequency saturation (1.2 is standard)
 * b  = length normalization (0.75 is standard)
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Retrieve the top-k chunks most relevant to a query.
 * Uses BM25 scoring — no embeddings, no external calls.
 *
 * @param document  A ParsedDocument (from parseDocument())
 * @param query     Free-text query, e.g. "React TypeScript experience"
 * @param topK      Max number of chunks to return (default 3)
 * @param minScore  Minimum BM25 score threshold (default 0.1)
 */
export function retrieve(
  document: ParsedDocument,
  query: string,
  topK = 3,
  minScore = 0.1
): RetrievalResult[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || document.chunks.length === 0) return [];

  const N = document.chunks.length;

  // Compute average document length (in tokens)
  const avgDl = document.chunks.reduce((sum, c) => sum + c.tokenCount, 0) / N;

  // IDF for each query term
  // IDF(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = document.chunks.filter((c) => c.termFrequency.has(term)).length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  // Score each chunk
  const scored: Array<{ chunk: TextChunk; score: number }> = document.chunks.map((chunk) => {
    let score = 0;
    const dl = chunk.tokenCount;

    for (const term of queryTerms) {
      const tf = chunk.termFrequency.get(term) ?? 0;
      if (tf === 0) continue;

      const termIdf = idf.get(term) ?? 0;
      // BM25 term score
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
      score += termIdf * (numerator / denominator);
    }

    return { chunk, score };
  });

  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ chunk: s.chunk, score: s.score, query }));
}

/**
 * Retrieve relevant passages across multiple queries and deduplicate.
 * Useful when you need context for several topics from a single document.
 */
export function retrieveMulti(
  document: ParsedDocument,
  queries: string[],
  topKPerQuery = 2
): RetrievalResult[] {
  const seen = new Set<number>();
  const results: RetrievalResult[] = [];

  for (const query of queries) {
    const hits = retrieve(document, query, topKPerQuery);
    for (const hit of hits) {
      if (!seen.has(hit.chunk.index)) {
        seen.add(hit.chunk.index);
        results.push(hit);
      }
    }
  }

  // Re-sort by score descending
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Convenience: extract the top-k passage texts as a single string.
 * Use this to build the context block injected into AI prompts.
 */
export function buildContextBlock(
  results: RetrievalResult[],
  maxChars = 3000
): string {
  if (results.length === 0) return "";

  const parts: string[] = [];
  let total = 0;

  for (const r of results) {
    const snippet = r.chunk.text.slice(0, maxChars - total);
    if (snippet.length < 20) break;
    parts.push(snippet);
    total += snippet.length;
    if (total >= maxChars) break;
  }

  return parts.join("\n\n---\n\n");
}

// ============================================================
// META EXTRACTION — heuristic, no ML
// ============================================================

/** Common technical skills to scan for */
const KNOWN_SKILLS = [
  "javascript", "typescript", "python", "java", "go", "rust", "c++", "c#",
  "react", "next.js", "vue", "angular", "svelte",
  "node.js", "express", "fastapi", "django", "spring",
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch",
  "aws", "gcp", "azure", "kubernetes", "docker", "terraform",
  "kafka", "rabbitmq", "grpc", "graphql", "rest",
  "machine learning", "pytorch", "tensorflow", "llm",
  "microservices", "distributed systems", "system design",
  "ci/cd", "github actions", "jenkins", "datadog", "prometheus",
];

function extractMeta(text: string): DocumentMeta {
  const lower = text.toLowerCase();

  // Detect section headings (lines that are short and title-case or all-caps)
  const lines = text.split("\n");
  const sections = lines
    .filter((l) => {
      const trimmed = l.trim();
      return (
        trimmed.length > 2 &&
        trimmed.length < 60 &&
        (
          /^[A-Z][A-Z\s&/()-]{2,}$/.test(trimmed) || // ALL CAPS
          /^#{1,3}\s/.test(trimmed) ||                // markdown heading
          /^[A-Z][a-z]+([\s][A-Z][a-z]+)*:?\s*$/.test(trimmed) // Title Case
        )
      );
    })
    .map((l) => l.trim().replace(/^#+\s*/, "").replace(/:$/, ""))
    .slice(0, 20);

  // Detect skills
  const skills = KNOWN_SKILLS.filter((s) => lower.includes(s));

  // Heuristic years of experience: "X years" or "X+ years"
  const yearsMatch = lower.match(/(\d+)\+?\s+years?\s+(?:of\s+)?(?:experience|exp)/);
  const yearsExperience = yearsMatch ? parseInt(yearsMatch[1] ?? "0") : null;

  // Resume heuristic: contains typical resume sections
  const resumeKeywords = ["experience", "education", "skills", "work history", "projects", "summary"];
  const resumeHits = resumeKeywords.filter((k) => lower.includes(k)).length;
  const isResume = resumeHits >= 3;

  return { sections, skills, yearsExperience, isResume };
}

// ============================================================
// CONVENIENCE EXPORTS
// ============================================================

/**
 * One-shot: parse a buffer and retrieve context for a query.
 * This is the main entry point for the session controller.
 */
export async function extractAndRetrieve(
  buffer: Buffer,
  queries: string[],
  fileType?: "pdf" | "docx" | "txt",
  topK = 3
): Promise<{
  document: ParsedDocument;
  context: string;
  results: RetrievalResult[];
}> {
  const document = await parseDocument(buffer, fileType);
  const results = retrieveMulti(document, queries, topK);
  const context = buildContextBlock(results);

  return { document, context, results };
}
