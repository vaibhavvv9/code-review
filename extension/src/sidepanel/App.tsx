import { useEffect, useState } from "react";
import type { ReviewResponse } from "./types.js";
import { ReviewResult } from "./ReviewResult.js";

const DEFAULT_BACKEND = "https://backend-eight-umber-nc58tqjhan.vercel.app";
const PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

type Status = "idle" | "loading" | "done" | "error";

export function App() {
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND);
  const [prUrl, setPrUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReviewResponse | null>(null);

  // Load saved backend URL and detect the PR in the active tab.
  useEffect(() => {
    chrome.storage?.sync.get(["backendUrl"]).then((v) => {
      if (typeof v.backendUrl === "string" && v.backendUrl) setBackendUrl(v.backendUrl);
    });
    detectActiveTabPr().then((url) => {
      if (url) setPrUrl(url);
    });
  }, []);

  async function detectActiveTabPr(): Promise<string | null> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && PR_URL_RE.test(tab.url)) return tab.url;
    } catch {
      /* ignore */
    }
    return null;
  }

  function saveBackendUrl(url: string) {
    setBackendUrl(url);
    chrome.storage?.sync.set({ backendUrl: url });
  }

  async function runReview() {
    if (!PR_URL_RE.test(prUrl)) {
      setStatus("error");
      setError("Enter a valid GitHub PR URL (https://github.com/owner/repo/pull/123).");
      return;
    }
    setStatus("loading");
    setError("");
    setResult(null);
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
      setResult(data as ReviewResponse);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unexpected error.");
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>AI Code Review</h1>
        <p className="subtitle">GitHub pull request reviewer</p>
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
        </details>
      </div>

      {status === "loading" && (
        <div className="info-box">Fetching the diff and analyzing the changes…</div>
      )}
      {status === "error" && <div className="error-box">{error}</div>}
      {status === "done" && result && <ReviewResult data={result} />}
      {status === "idle" && (
        <div className="info-box">
          Open a GitHub pull request, then click <strong>Review this PR</strong>. The URL is
          detected automatically from the active tab.
        </div>
      )}
    </div>
  );
}
