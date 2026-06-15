/**
 * Review generation: builds a focused prompt from PR metadata + diff and
 * asks OpenAI to return a structured JSON review.
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

// Keep the diff within a reasonable token budget. ~12k chars is a pragmatic cap.
const MAX_DIFF_CHARS = 48_000;

const SYSTEM_PROMPT = `You are a senior software engineer performing a thorough code review of a GitHub pull request.
You review both frontend and backend code. Prioritize, in order: correctness (bugs, logic errors, edge cases), security (injection, secrets, auth/authorization flaws, unsafe input handling), code quality (readability, naming, structure, best practices), and performance.

Rules:
- Only comment on the changed lines shown in the diff. Use the file paths from the diff headers.
- Be specific and actionable. Avoid generic praise and nitpicks that don't matter.
- If the code looks good, return an empty comments array and say so in the summary.
- Estimate the line number from the diff hunk headers where possible; use null if you cannot.
- Respond ONLY with valid JSON matching the requested schema. No markdown, no prose outside JSON.`;

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

export async function generateReview(info: PrInfo, diff: string): Promise<Review> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await getClient().chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(info, diff) },
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
    summary: typeof parsed.summary === "string" ? parsed.summary : "No summary provided.",
    comments,
  };
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
