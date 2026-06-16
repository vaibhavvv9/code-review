# AI Code Review

An open-source AI code reviewer for GitHub pull requests. Two clients share one backend:

- **Web app** — paste a GitHub PR link, stream the review in your browser, and optionally post it back to the PR as inline comments.
- **Chrome extension** — a side panel that detects the PR in your active tab and shows the same structured review.

The backend fetches the diff via the GitHub API, runs it through an AI model, and returns a structured review (correctness, security, code quality, performance).

> Scope: reviewing supports public GitHub repositories / public PRs. Posting a review back to a PR requires a GitHub token with write access (supplied by you in the web app, used per-request and never stored).

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
| `OPENAI_BASE_URL` | no       | OpenAI-compatible gateway base URL (e.g. OpenRouter).             |

### Deploy the backend to Vercel

The backend ships with a serverless entry point (`backend/api/index.ts`) and a `backend/vercel.json`, so it can run on Vercel without code changes.

**Via the dashboard (recommended):**

1. Go to [vercel.com/new](https://vercel.com/new) and import `https://github.com/vaibhavvv9/code-review`.
2. Set **Root Directory** to `backend`.
3. Framework preset: **Other** (the included `vercel.json` already defines build/install commands).
4. Add environment variables (Settings → Environment Variables):
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL` (e.g. `https://openrouter.ai/api/v1` for OpenRouter)
   - `OPENAI_MODEL` (e.g. `openai/gpt-4o-mini`)
   - `ALLOWED_ORIGINS` (set to your extension origin, see below)
5. Deploy. You'll get a URL like `https://your-project.vercel.app`.
6. Verify: open `https://your-project.vercel.app/health`.

**Via the CLI:**

```bash
cd backend
npx vercel login
npx vercel link            # create/link the project (set root to current dir)
npx vercel env add OPENAI_API_KEY
npx vercel env add OPENAI_BASE_URL
npx vercel env add OPENAI_MODEL
npx vercel env add ALLOWED_ORIGINS
npx vercel --prod          # deploy to production
```

Then point the extension at the deployed URL via **Settings → Backend URL** in the side panel.

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

## 3. Run the web app

```bash
cd web
npm install
npm run dev        # dev server (Vite) on http://localhost:5173
# or
npm run build      # static build to web/dist
```

Open the dev URL, then:

1. Paste a public GitHub pull request URL (e.g. `https://github.com/owner/repo/pull/123`).
2. (Optional) Open **Settings** to set the backend URL (persisted in `localStorage`), choose a model, a review focus (all / correctness / security / quality / performance), and a max-comments cap.
3. Click **Review this PR** — results stream in live (status → findings → summary).
4. (Optional) To post the review back to the PR, expand **Post to GitHub**, paste a GitHub token with write access, and click **Post review to PR**. The token is sent once with the request and is never stored or logged.

Deploy `web/dist` to any static host (Vercel, Netlify, GitHub Pages). Set the backend URL via **Settings** to your deployed backend.

## 4. Use the extension

1. Open any public GitHub pull request, e.g. `https://github.com/owner/repo/pull/123`.
2. Click the extension icon to open the side panel. The PR URL is auto-detected from the active tab (you can also paste one).
3. Click **Review this PR**.

The panel shows the PR metadata, an AI summary, and a list of findings sorted by severity, each tagged by category with an optional suggested fix.

If your backend runs somewhere other than `http://localhost:8787`, set it under **Settings → Backend URL** in the panel.

## API endpoints

| Endpoint | Description |
| --- | --- |
| `POST /api/review` | Body `{ prUrl, config? }`. Returns `{ pr, review }`. `config` is `{ model?, focus?, maxComments? }`. |
| `POST /api/review/stream` | Same body; streams Server-Sent Events (`pr`, `status`, `comment`, `summary`, `done`, `error`) as the review runs. |
| `POST /api/review/post` | Body `{ prUrl, githubToken, review }`. Posts the review to the PR as inline comments + a summary; returns `{ url, posted }`. The token is used per-request and never stored or logged. |
| `GET /health` | Liveness check; returns the active model. |

## How the review works

The backend fetches the PR's unified diff and sends it to the AI model with a system prompt instructing it to review only changed lines and prioritize correctness → security → code quality → performance. The model returns JSON, which the backend validates and the clients render.

For large PRs, the diff is split by file into chunks that each fit a token budget, reviewed independently (map), and merged into one summary + capped, severity-sorted findings (reduce) — so large PRs are no longer hard-truncated. The streaming endpoint emits findings as each chunk completes.

When posting back to GitHub, each finding whose line maps to a changed (RIGHT-side) line in the diff becomes an inline comment; findings that can't be mapped are appended to the review summary body. The review is posted with the neutral `COMMENT` event (it never approves or requests changes).

## Limitations

- Reviewing supports public repositories only (no auth flow for private repos yet).
- Posting a review requires a user-supplied GitHub token with write access.
- No persistence — reviews are not stored or shareable via a link.

## License

MIT
