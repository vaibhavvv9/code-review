# AI Code Review

An open-source Chrome extension that generates AI-powered code reviews for GitHub pull requests. It detects the PR in your active tab, fetches the diff via the GitHub API through a small backend proxy, and shows a structured review (correctness, security, code quality, performance) in a side panel.

> Scope: public GitHub repositories / public PRs. Read-only — it does not post comments back to GitHub.

## Architecture

```
Chrome extension (React side panel, MV3)
        │  POST /api/review { prUrl }
        ▼
Backend proxy (Node + Express + TS)
        ├── fetch PR metadata + unified diff  ──> GitHub REST API
        └── build prompt + analyze diff       ──> OpenAI API
        ▲
        │  { pr, review }
        ▼
Side panel renders summary + findings
```

The OpenAI API key stays on the backend and is never shipped in the extension.

## Project layout

```
backend/      Express + TypeScript API (GitHub fetch + OpenAI review)
extension/    Manifest V3 Chrome extension (React + Vite side panel)
```

## Prerequisites

- Node.js 18+ (uses the global `fetch` available in Node 18+)
- An OpenAI API key
- (Optional) a GitHub token to raise the API rate limit

## 1. Run the backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY (and optionally GITHUB_TOKEN)
npm run dev
```

The server starts on `http://localhost:8787`. Check `http://localhost:8787/health`.

### Backend environment variables

| Variable          | Required | Description                                                        |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`  | yes      | OpenAI API key used to generate reviews.                           |
| `OPENAI_MODEL`    | no       | Model name (default `gpt-4o-mini`).                                |
| `GITHUB_TOKEN`    | no       | Raises GitHub rate limit from 60/hr to 5000/hr. Read access only.  |
| `PORT`            | no       | Server port (default `8787`).                                      |
| `ALLOWED_ORIGINS` | no       | Comma-separated CORS origins, or `*` (default) to allow all.       |

## 2. Build and load the extension

```bash
cd extension
npm install
npm run build      # outputs to extension/dist
```

Then in Chrome:

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist` folder.
4. Pin the **AI Code Review** extension and click its icon to open the side panel.

For live rebuilds during development, run `npm run dev` (rebuilds on change); reload the extension in `chrome://extensions` to pick up changes.

## 3. Use it

1. Open any public GitHub pull request, e.g. `https://github.com/owner/repo/pull/123`.
2. Click the extension icon to open the side panel. The PR URL is auto-detected from the active tab (you can also paste one).
3. Click **Review this PR**.

The panel shows the PR metadata, an AI summary, and a list of findings sorted by severity, each tagged by category with an optional suggested fix.

If your backend runs somewhere other than `http://localhost:8787`, set it under **Settings → Backend URL** in the panel.

## How the review works

The backend fetches the PR's unified diff and sends it to OpenAI with a system prompt instructing the model to review only changed lines and prioritize correctness → security → code quality → performance. The model returns JSON, which the backend validates and the extension renders.

Large diffs are truncated to stay within a reasonable token budget.

## Limitations

- Public repositories only (no auth flow for private repos yet).
- Read-only; reviews are not posted back to the PR.
- Very large PRs are truncated.

## License

MIT
