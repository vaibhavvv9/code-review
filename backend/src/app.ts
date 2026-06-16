import express from "express";
import type { Express } from "express";
import cors from "cors";
import { z } from "zod";
import {
  parsePrUrl,
  fetchPrData,
  fetchPrFiles,
  buildInlineComments,
  postReview,
  GitHubError,
} from "./github.js";
import { generateReview, generateReviewStream } from "./review.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowed.includes("*") ? true : allowed,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", model: process.env.OPENAI_MODEL || "gpt-4o-mini" });
  });

  const configSchema = z
    .object({
      model: z.string().min(1).optional(),
      focus: z
        .enum(["all", "correctness", "security", "quality", "performance"])
        .optional(),
      maxComments: z.number().int().positive().max(200).optional(),
    })
    .optional();

  const reviewSchema = z.object({
    prUrl: z.string().url(),
    config: configSchema,
  });

  app.post("/api/review", async (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Request must include a valid 'prUrl'." });
    }

    const pr = parsePrUrl(parsed.data.prUrl);
    if (!pr) {
      return res
        .status(400)
        .json({ error: "Not a valid GitHub pull request URL (expected https://github.com/owner/repo/pull/123)." });
    }

    try {
      const { info, diff } = await fetchPrData(pr);

      if (!diff.trim()) {
        return res.status(422).json({ error: "The PR has no diff to review." });
      }

      const review = await generateReview(info, diff, parsed.data.config);
      return res.json({ pr: info, review });
    } catch (err) {
      return handleError(err, res);
    }
  });

  // Streaming review via Server-Sent Events. Events: pr, status, comment,
  // summary, done, error. The client reads the streamed response body.
  app.post("/api/review/stream", async (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Request must include a valid 'prUrl'." });
    }

    const pr = parsePrUrl(parsed.data.prUrl);
    if (!pr) {
      return res
        .status(400)
        .json({ error: "Not a valid GitHub pull request URL (expected https://github.com/owner/repo/pull/123)." });
    }

    let info, diff;
    try {
      ({ info, diff } = await fetchPrData(pr));
      if (!diff.trim()) {
        return res.status(422).json({ error: "The PR has no diff to review." });
      }
    } catch (err) {
      return handleError(err, res);
    }

    // Headers are sent now; from here on errors are streamed, not status codes.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "pr", pr: info });

    await generateReviewStream(info, diff, parsed.data.config, send);
    res.end();
  });

  const postSchema = z.object({
    prUrl: z.string().url(),
    githubToken: z.string().min(1),
    review: z.object({
      summary: z.string(),
      comments: z.array(
        z.object({
          file: z.string(),
          line: z.number().nullable(),
          severity: z.enum(["critical", "high", "medium", "low", "info"]),
          category: z.enum(["correctness", "security", "quality", "performance"]),
          title: z.string(),
          description: z.string(),
          suggestion: z.string().nullable(),
        }),
      ),
    }),
  });

  // Post a generated review back to the PR as inline comments + a summary.
  // The GitHub token is used per-request and never stored or logged.
  app.post("/api/review/post", async (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Request must include 'prUrl', 'githubToken', and a 'review'." });
    }

    const pr = parsePrUrl(parsed.data.prUrl);
    if (!pr) {
      return res
        .status(400)
        .json({ error: "Not a valid GitHub pull request URL (expected https://github.com/owner/repo/pull/123)." });
    }

    try {
      const { githubToken, review } = parsed.data;
      const files = await fetchPrFiles(pr, githubToken);
      const { inline, unmapped } = buildInlineComments(files, review.comments);

      let body = `## AI Code Review\n\n${review.summary}`;
      if (unmapped.length > 0) {
        body += `\n\n### Additional findings\n`;
        for (const c of unmapped) {
          body += `\n- **[${c.severity}/${c.category}] ${c.title}** (${c.file}${
            c.line != null ? `:${c.line}` : ""
          }) — ${c.description}`;
        }
      }

      const url = await postReview(pr, githubToken, body, inline);
      return res.json({ url, posted: { inline: inline.length, summaryOnly: unmapped.length } });
    } catch (err) {
      return handleError(err, res);
    }
  });

  return app;
}

function handleError(err: unknown, res: express.Response) {
  if (err instanceof GitHubError) {
    const status = err.status === 404 ? 404 : err.status === 403 ? 429 : err.status === 401 ? 401 : 502;
    return res.status(status).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[review] error:", message);
  return res.status(500).json({ error: message });
}
