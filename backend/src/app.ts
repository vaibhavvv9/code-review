import express from "express";
import cors from "cors";
import { z } from "zod";
import { parsePrUrl, fetchPrData, GitHubError } from "./github.js";
import { generateReview } from "./review.js";

export function createApp() {
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

  const reviewSchema = z.object({
    prUrl: z.string().url(),
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

      const review = await generateReview(info, diff);
      return res.json({ pr: info, review });
    } catch (err) {
      if (err instanceof GitHubError) {
        const status = err.status === 404 ? 404 : err.status === 403 ? 429 : 502;
        return res.status(status).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "Unexpected error.";
      console.error("[review] error:", message);
      return res.status(500).json({ error: message });
    }
  });

  return app;
}
