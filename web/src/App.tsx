import { useEffect, useState } from "react";
import type {
  PrInfo,
  ReviewComment,
  ReviewConfig,
  ReviewFocus,
} from "./types.js";
import { streamReview, postReview } from "./api.js";
import { ReviewResult } from "./components/ReviewResult.js";

const DEFAULT_BACKEND = "https://backend-eight-umber-nc58tqjhan.vercel.app";
const PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

type Status = "idle" | "loading" | "done" | "error";
type PostStatus = "idle" | "posting" | "done" | "error";

export function App() {
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND);
  const [prUrl, setPrUrl] = useState("");
  const [model, setModel] = useState("");
  const [focus, setFocus] = useState<ReviewFocus>("all");
  const [maxComments, setMaxComments] = useState<number | "">("");

  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");

  const [pr, setPr] = useState<PrInfo | null>(null);
  const [summary, setSummary] = useState("");
  const [comments, setComments] = useState<ReviewComment[]>([]);

  // Post-to-GitHub state.
  const [token, setToken] = useState("");
  const [postStatus, setPostStatus] = useState<PostStatus>("idle");
  const [postError, setPostError] = useState("");
  const [postUrl, setPostUrl] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("backendUrl");
    if (saved) setBackendUrl(saved);
  }, []);

  function saveBackendUrl(url: string) {
    setBackendUrl(url);
    localStorage.setItem("backendUrl", url);
  }

  async function runReview() {
    if (!PR_URL_RE.test(prUrl)) {
      setStatus("error");
      setError("Enter a valid GitHub PR URL (https://github.com/owner/repo/pull/123).");
      return;
    }
    setStatus("loading");
    setStatusMsg("");
    setError("");
    setPr(null);
    setSummary("");
    setComments([]);
    setPostStatus("idle");
    setPostError("");
    setPostUrl("");

    const config: ReviewConfig = { focus };
    if (model.trim()) config.model = model.trim();
    if (typeof maxComments === "number") config.maxComments = maxComments;

    try {
      await streamReview(backendUrl, prUrl, config, (event) => {
        switch (event.type) {
          case "pr":
            setPr(event.pr);
            break;
          case "status":
            setStatusMsg(event.message);
            break;
          case "comment":
            setComments((prev) => [...prev, event.comment]);
            break;
          case "summary":
            setSummary(event.summary);
            break;
          case "done":
            setSummary(event.review.summary);
            setComments(event.review.comments);
            setStatus("done");
            break;
          case "error":
            setStatus("error");
            setError(event.error);
            break;
        }
      });
      // If the stream ended without an explicit done/error, settle to done.
      setStatus((s) => (s === "loading" ? "done" : s));
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unexpected error.");
    }
  }

  async function runPost() {
    if (!token.trim()) {
      setPostStatus("error");
      setPostError("Enter a GitHub token with write access to the repository.");
      return;
    }
    setPostStatus("posting");
    setPostError("");
    setPostUrl("");
    try {
      const result = await postReview(backendUrl, {
        prUrl,
        githubToken: token.trim(),
        review: { summary, comments },
      });
      setPostUrl(result.url);
      setPostStatus("done");
    } catch (err) {
      setPostStatus("error");
      setPostError(err instanceof Error ? err.message : "Unexpected error.");
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>AI Code Review</h1>
        <p className="subtitle">Paste a GitHub pull request link to get an AI review</p>
      </header>

      <div className="controls">
        <label className="label" htmlFor="prUrl">
          PR URL
        </label>
        <input
          id="prUrl"
          className="input"
          type="text"
          placeholder="https://github.com/owner/repo/pull/123"
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
        />
        <button className="button" onClick={runReview} disabled={status === "loading"}>
          {status === "loading" ? "Reviewing…" : "Review this PR"}
        </button>

        <details className="settings">
          <summary>Settings</summary>

          <label className="label" htmlFor="backend">
            Backend URL
          </label>
          <input
            id="backend"
            className="input"
            type="text"
            value={backendUrl}
            onChange={(e) => saveBackendUrl(e.target.value)}
          />

          <label className="label" htmlFor="model">
            Model (optional)
          </label>
          <input
            id="model"
            className="input"
            type="text"
            placeholder="e.g. openai/gpt-4o-mini"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />

          <label className="label" htmlFor="focus">
            Focus
          </label>
          <select
            id="focus"
            className="input"
            value={focus}
            onChange={(e) => setFocus(e.target.value as ReviewFocus)}
          >
            <option value="all">All categories</option>
            <option value="correctness">Correctness</option>
            <option value="security">Security</option>
            <option value="quality">Code quality</option>
            <option value="performance">Performance</option>
          </select>

          <label className="label" htmlFor="maxComments">
            Max comments (optional)
          </label>
          <input
            id="maxComments"
            className="input"
            type="number"
            min={1}
            placeholder="50"
            value={maxComments}
            onChange={(e) =>
              setMaxComments(e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </details>
      </div>

      {status === "loading" && (
        <div className="info-box">{statusMsg || "Fetching the diff and analyzing the changes…"}</div>
      )}
      {status === "error" && <div className="error-box">{error}</div>}

      {(status === "loading" || status === "done") && (
        <ReviewResult pr={pr} summary={summary} comments={comments} />
      )}

      {status === "done" && (
        <section className="post-section">
          <h2>Post to GitHub</h2>
          <p className="hint">
            Posts the summary plus inline comments to the PR. Needs a GitHub token with
            write access (classic <code>repo</code> scope, or fine-grained{" "}
            <code>Pull requests: write</code>). The token is used once and never stored.
          </p>
          <label className="label" htmlFor="token">
            GitHub token
          </label>
          <input
            id="token"
            className="input"
            type="password"
            placeholder="ghp_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <div className="preview">
            Will post 1 summary + {comments.length} finding(s).
          </div>
          <button className="button" onClick={runPost} disabled={postStatus === "posting"}>
            {postStatus === "posting" ? "Posting…" : "Post review to PR"}
          </button>
          {postStatus === "error" && <div className="error-box">{postError}</div>}
          {postStatus === "done" && (
            <div className="info-box">
              Review posted.{" "}
              <a href={postUrl} target="_blank" rel="noreferrer">
                Open the PR
              </a>
              .
            </div>
          )}
        </section>
      )}

      {status === "idle" && (
        <div className="info-box">
          Paste a public GitHub pull request URL above and click{" "}
          <strong>Review this PR</strong>.
        </div>
      )}
    </div>
  );
}
