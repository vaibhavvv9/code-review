/**
 * Review generation: builds a focused prompt from PR metadata + diff and
 * asks OpenAI to return a structured JSON review.
 *
 * Supports per-request configuration (model / focus / max comments),
 * large-diff chunking (map-reduce over files), and a streaming variant
 * that emits incremental events as chunks complete.
 */
import OpenAI from "openai";
import type { PrInfo } from "./github.js";

export interface ReviewComment {
  file: string;
  line: number | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "correctness" | "security" | "quality" | "performance";
  title: string;
  description: string;
  suggestion: string | null;
}

export interface Review {
  summary: string;
  comments: ReviewComment[];
}

export type ReviewFocus =
  | "all"
  | "correctness"
  | "security"
  | "quality"
  | "performance";

export interface ReviewConfig {
  model?: string;
  focus?: ReviewFocus;
  maxComments?: number;
}

/** A single streaming event emitted during a review. */
export type ReviewEvent =
  | { type: "status"; message: string }
  | { type: "summary"; summary: string }
  | { type: "comment"; comment: ReviewComment }
  | { type: "done"; review: Review }
  | { type: "error"; error: string };

// Keep each model call within a reasonable token budget. Diffs larger than this
// are split into multiple file-based chunks and reviewed independently.
const MAX_DIFF_CHARS = 48_000;
const DEFAULT_MAX_COMMENTS = 50;
const CHUNK_CONCURRENCY = 3;

const SEVERITY_ORDER: Record<ReviewComment["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const FOCUS_INSTRUCTIONS: Record<Exclude<ReviewFocus, "all">, string> = {
  correctness:
    "Focus primarily on correctness: bugs, logic errors, and edge cases. Only raise other categories when severe.",
  security:
    "Focus primarily on security: injection, secrets, auth/authorization flaws, and unsafe input handling. Only raise other categories when severe.",
  quality:
    "Focus primarily on code quality: readability, naming, structure, and best practices. Only raise other categories when severe.",
  performance:
    "Focus primarily on performance: unnecessary work, allocations, and inefficient algorithms. Only raise other categories when severe.",
};

function buildSystemPrompt(focus: ReviewFocus = "all"): string {
  const base = `You are a senior software engineer performing a thorough code review of a GitHub pull request.
You review both frontend and backend code. Prioritize, in order: correctness (bugs, logic errors, edge cases), security (injection, secrets, auth/authorization flaws, unsafe input handling), code quality (readability, naming, structure, best practices), and performance.

Rules:
- Only comment on the changed lines shown in the diff. Use the file paths from the diff headers.
- Be specific and actionable. Avoid generic praise and nitpicks that don't matter.
- If the code looks good, return an empty comments array and say so in the summary.
- Estimate the line number from the diff hunk headers where possible; use null if you cannot.
- Respond ONLY with valid JSON matching the requested schema. No markdown, no prose outside JSON.`;

  if (focus && focus !== "all") {
    return `${base}\n\nReview focus: ${FOCUS_INSTRUCTIONS[focus]}`;
  }
  return base;
}

function buildUserPrompt(info: PrInfo, diff: string): string {
  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated due to size]"
      : diff;

  return `Pull request: ${info.title}
Author: ${info.author}
Base: ${info.baseRef} <- Head: ${info.headRef}
Files changed: ${info.changedFiles}, +${info.additions} / -${info.deletions}

Description:
${info.body || "(no description provided)"}

Unified diff:
\`\`\`diff
${truncated}
\`\`\`

Return JSON with this exact shape:
{
  "summary": "string - a concise overview of the PR and the main findings",
  "comments": [
    {
      "file": "path/to/file",
      "line": 123,
      "severity": "critical|high|medium|low|info",
      "category": "correctness|security|quality|performance",
      "title": "short issue title",
      "description": "what is wrong and why it matters",
      "suggestion": "concrete fix, or null"
    }
  ]
}`;
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured on the server.");
    // OPENAI_BASE_URL lets you use an OpenAI-compatible gateway (e.g. OpenRouter).
    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}

function resolveModel(config?: ReviewConfig): string {
  return config?.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
}

/**
 * Split a unified diff into per-file chunks, then greedily pack files into
 * chunks that stay under MAX_DIFF_CHARS. A single oversized file becomes its
 * own chunk (still truncated as a last resort inside the prompt).
 */
export function splitDiffByFile(diff: string): string[] {
  // Each file section starts with "diff --git". Keep the marker on each piece.
  const parts = diff
    .split(/\n(?=diff --git )/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return [];

  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length + 1 > MAX_DIFF_CHARS) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${part}` : part;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Run an async mapper over items with a bounded concurrency limit. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Review a single diff chunk with one model call. */
async function reviewChunk(
  info: PrInfo,
  chunk: string,
  config?: ReviewConfig,
): Promise<Review> {
  const completion = await getClient().chat.completions.create({
    model: resolveModel(config),
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(config?.focus) },
      { role: "user", content: buildUserPrompt(info, chunk) },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The AI returned a response that could not be parsed as JSON.");
  }

  const comments: ReviewComment[] = Array.isArray(parsed.comments)
    ? parsed.comments.map(normalizeComment)
    : [];

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    comments,
  };
}

function sortAndCap(comments: ReviewComment[], maxComments?: number): ReviewComment[] {
  const sorted = [...comments].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const cap = maxComments && maxComments > 0 ? maxComments : DEFAULT_MAX_COMMENTS;
  return sorted.slice(0, cap);
}

/**
 * Generate a review for the full diff. Small diffs use a single call; large
 * diffs are split by file and reviewed in parallel, then merged.
 */
export async function generateReview(
  info: PrInfo,
  diff: string,
  config?: ReviewConfig,
): Promise<Review> {
  if (diff.length <= MAX_DIFF_CHARS) {
    const review = await reviewChunk(info, diff, config);
    return {
      summary: review.summary || "No summary provided.",
      comments: sortAndCap(review.comments, config?.maxComments),
    };
  }

  const chunks = splitDiffByFile(diff);
  const reviews = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, (chunk) =>
    reviewChunk(info, chunk, config),
  );

  const summary = mergeSummaries(reviews);
  const comments = sortAndCap(
    reviews.flatMap((r) => r.comments),
    config?.maxComments,
  );
  return { summary, comments };
}

function mergeSummaries(reviews: Review[]): string {
  const parts = reviews.map((r) => r.summary.trim()).filter(Boolean);
  if (parts.length === 0) return "No summary provided.";
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => `Group ${i + 1}: ${p}`).join("\n\n");
}

/**
 * Streaming variant: emits incremental events (status, comment, summary, done)
 * via the provided callback. Comments stream as each chunk completes.
 */
export async function generateReviewStream(
  info: PrInfo,
  diff: string,
  config: ReviewConfig | undefined,
  onEvent: (event: ReviewEvent) => void,
): Promise<void> {
  try {
    const chunks = diff.length <= MAX_DIFF_CHARS ? [diff] : splitDiffByFile(diff);
    onEvent({
      type: "status",
      message:
        chunks.length > 1
          ? `Analyzing ${chunks.length} file group(s)…`
          : "Analyzing the changes…",
    });

    const all: ReviewComment[] = [];
    const summaries: Review[] = [];

    // Run sequentially so comments stream in a stable order with progress.
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        onEvent({ type: "status", message: `Reviewing group ${i + 1} of ${chunks.length}…` });
      }
      const review = await reviewChunk(info, chunks[i], config);
      summaries.push(review);
      for (const comment of sortAndCap(review.comments)) {
        all.push(comment);
        onEvent({ type: "comment", comment });
      }
    }

    const summary = mergeSummaries(summaries);
    const comments = sortAndCap(all, config?.maxComments);
    onEvent({ type: "summary", summary });
    onEvent({ type: "done", review: { summary, comments } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error during review.";
    onEvent({ type: "error", error: message });
  }
}

function normalizeComment(c: any): ReviewComment {
  const severities = ["critical", "high", "medium", "low", "info"];
  const categories = ["correctness", "security", "quality", "performance"];
  return {
    file: typeof c.file === "string" ? c.file : "unknown",
    line: typeof c.line === "number" ? c.line : null,
    severity: severities.includes(c.severity) ? c.severity : "info",
    category: categories.includes(c.category) ? c.category : "quality",
    title: typeof c.title === "string" ? c.title : "Issue",
    description: typeof c.description === "string" ? c.description : "",
    suggestion: typeof c.suggestion === "string" ? c.suggestion : null,
  };
}
