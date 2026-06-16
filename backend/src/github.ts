/**
 * GitHub helpers: parse a PR URL, fetch its metadata + diff via the REST API,
 * fetch changed files (for inline-comment line mapping), and post a review back
 * to the PR using a caller-supplied token.
 *
 * Reading supports public repositories. Writing (postReview) requires a token
 * with write access to the repository's pull requests.
 */
import type { ReviewComment } from "./review.js";

export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
}

export interface PrInfo {
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  htmlUrl: string;
}

export interface PrData {
  info: PrInfo;
  diff: string;
}

const GITHUB_API = "https://api.github.com";

/**
 * Parse a GitHub PR URL like:
 *   https://github.com/owner/repo/pull/123
 * Returns null when the URL is not a recognizable PR URL.
 */
export function parsePrUrl(url: string): ParsedPr | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return null;
    const match = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  } catch {
    return null;
  }
}

/**
 * Build GitHub API headers. A caller-supplied `token` (e.g. a user PAT for
 * write operations) takes precedence over the server's `GITHUB_TOKEN`.
 */
function authHeaders(
  extra: Record<string, string> = {},
  token?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ai-code-review-extension",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
  const auth = token || process.env.GITHUB_TOKEN;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return headers;
}

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "GitHubError";
  }
}

/** Fetch PR metadata and the unified diff. */
export async function fetchPrData(pr: ParsedPr): Promise<PrData> {
  const base = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;

  const [metaRes, diffRes] = await Promise.all([
    fetch(base, { headers: authHeaders() }),
    fetch(base, { headers: authHeaders({ Accept: "application/vnd.github.v3.diff" }) }),
  ]);

  if (!metaRes.ok) {
    throw new GitHubError(
      `Failed to fetch PR metadata (${metaRes.status}). ${await safeText(metaRes)}`,
      metaRes.status,
    );
  }
  if (!diffRes.ok) {
    throw new GitHubError(
      `Failed to fetch PR diff (${diffRes.status}). ${await safeText(diffRes)}`,
      diffRes.status,
    );
  }

  const meta = (await metaRes.json()) as any;
  const diff = await diffRes.text();

  const info: PrInfo = {
    title: meta.title ?? "",
    body: meta.body ?? "",
    author: meta.user?.login ?? "unknown",
    baseRef: meta.base?.ref ?? "",
    headRef: meta.head?.ref ?? "",
    changedFiles: meta.changed_files ?? 0,
    additions: meta.additions ?? 0,
    deletions: meta.deletions ?? 0,
    htmlUrl: meta.html_url ?? "",
  };

  return { info, diff };
}

async function safeText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any;
    return data?.message ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Write-back: fetch changed files, map findings to lines, and post a review.
// ---------------------------------------------------------------------------

export interface PrFile {
  filename: string;
  patch?: string;
}

/** An inline review comment in GitHub's line-based Reviews API format. */
export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Fetch the list of files changed in a PR (with their unified-diff patches). */
export async function fetchPrFiles(pr: ParsedPr, token?: string): Promise<PrFile[]> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100`;
  const res = await fetch(url, { headers: authHeaders({}, token) });
  if (!res.ok) {
    throw new GitHubError(
      `Failed to fetch PR files (${res.status}). ${await safeText(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as any[];
  return data.map((f) => ({ filename: f.filename, patch: f.patch }));
}

/**
 * Collect the set of new-side (RIGHT) line numbers present in a file's patch.
 * Lines added ("+") and context (" ") lines are addressable for review comments.
 */
function rightSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line: does not advance the new-side counter
    } else {
      // context line
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

function formatCommentBody(c: ReviewComment): string {
  let body = `**[${c.severity}/${c.category}] ${c.title}**\n\n${c.description}`;
  if (c.suggestion) {
    body += `\n\n**Suggestion:**\n\`\`\`\n${c.suggestion}\n\`\`\``;
  }
  return body;
}

/**
 * Split findings into inline comments (mappable to a valid RIGHT-side line in
 * the diff) and unmapped findings (to be appended to the review body).
 */
export function buildInlineComments(
  files: PrFile[],
  comments: ReviewComment[],
): { inline: InlineComment[]; unmapped: ReviewComment[] } {
  const lineMap = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.patch) lineMap.set(f.filename, rightSideLines(f.patch));
  }

  const inline: InlineComment[] = [];
  const unmapped: ReviewComment[] = [];
  for (const c of comments) {
    const lines = c.line != null ? lineMap.get(c.file) : undefined;
    if (c.line != null && lines && lines.has(c.line)) {
      inline.push({ path: c.file, line: c.line, side: "RIGHT", body: formatCommentBody(c) });
    } else {
      unmapped.push(c);
    }
  }
  return { inline, unmapped };
}

/**
 * Post a Pull Request Review with a summary body and inline comments.
 * Uses the neutral COMMENT event (not APPROVE / REQUEST_CHANGES).
 * Returns the PR's html_url.
 */
export async function postReview(
  pr: ParsedPr,
  token: string,
  body: string,
  inline: InlineComment[],
): Promise<string> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }, token),
    body: JSON.stringify({ body, event: "COMMENT", comments: inline }),
  });
  if (!res.ok) {
    throw new GitHubError(
      `Failed to post review (${res.status}). ${await safeText(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as any;
  return data.pull_request_url
    ? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`
    : data.html_url ?? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}
