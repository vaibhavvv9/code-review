/**
 * GitHub helpers: parse a PR URL and fetch its metadata + diff via the REST API.
 * Only public repositories are supported in this version.
 */

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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ai-code-review-extension",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
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
