# Plan — Web App + AI Code Reviewer Platform Features

Spec: `docs/superpowers/specs/2026-06-16-web-app-and-platform-features-design.md`

## Summary

Add a standalone **web app** (`web/`) to paste a GitHub PR link and view the AI review, and extend the **backend** with: post-review-back-to-GitHub (inline comments via user PAT), SSE **streaming**, large-diff **chunking (map-reduce)**, and per-request **review config** (model / focus / max comments). The Chrome extension is unchanged. No database.

## Current State Analysis (grounded in Phase 1 exploration)

- [backend/src/app.ts](file:///Users/bytedance/Documents/Projects/code-review/backend/src/app.ts): Express factory, CORS from `ALLOWED_ORIGINS`, `/health`, `POST /api/review` with `zod` validation; GitHubError → status mapping.
- [backend/src/review.ts](file:///Users/bytedance/Documents/Projects/code-review/backend/src/review.ts): `generateReview(info, diff)`, single OpenAI call (JSON mode), `MAX_DIFF_CHARS = 48_000` truncation, `normalizeComment`.
- [backend/src/github.ts](file:///Users/bytedance/Documents/Projects/code-review/backend/src/github.ts): `parsePrUrl`, `fetchPrData`, `authHeaders` (env `GITHUB_TOKEN`), `GitHubError`.
- [extension/src/sidepanel/ReviewResult.tsx](file:///Users/bytedance/Documents/Projects/code-review/extension/src/sidepanel/ReviewResult.tsx) + [styles.css](file:///Users/bytedance/Documents/Projects/code-review/extension/src/sidepanel/styles.css): card UI + dark theme to port.
- [extension/vite.config.ts](file:///Users/bytedance/Documents/Projects/code-review/extension/vite.config.ts), [extension/package.json](file:///Users/bytedance/Documents/Projects/code-review/extension/package.json): React 18 + Vite 5 stack to mirror.

## Proposed Changes

### Step 1 — Backend: review config + chunking (`backend/src/review.ts`)
- Export `ReviewConfig = { model?: string; focus?: "all"|"correctness"|"security"|"quality"|"performance"; maxComments?: number }`.
- Refactor `SYSTEM_PROMPT` into `buildSystemPrompt(focus)` that appends a focus instruction when `focus && focus !== "all"`.
- Add `splitDiffByFile(diff): string[]` — split on `\ndiff --git ` boundaries (keep the leading `diff --git`), then greedily pack into chunks `<= MAX_DIFF_CHARS`. A single oversized file is its own chunk (still truncated as a last resort).
- Add `reviewChunk(info, chunk, config): Promise<Review>` (the existing single-call logic, parameterized by `model` and system prompt).
- Rewrite `generateReview(info, diff, config?)`:
  - `model = config?.model || env || "gpt-4o-mini"`.
  - If `diff.length <= MAX_DIFF_CHARS` → one `reviewChunk`.
  - Else → `splitDiffByFile`, run chunks with bounded concurrency (helper `mapWithConcurrency(items, 3, fn)`), merge: summary = joined non-empty chunk summaries; comments = flattened, severity-sorted, capped to `config?.maxComments ?? 50`.
- Add `generateReviewStream(info, diff, config, onEvent)`:
  - Emit `{type:"status"}` (e.g. "Analyzing N file group(s)…"), per-chunk status, `{type:"comment"}` as each chunk resolves, then `{type:"summary"}`, then `{type:"done", review}`. Wrap in try/catch → `{type:"error"}`.
- Verify: `cd backend && npm run typecheck`.

### Step 2 — Backend: GitHub files + write-back + line mapping (`backend/src/github.ts`)
- `authHeaders(extra, token?)` — use `token ?? process.env.GITHUB_TOKEN` for `Authorization`.
- `fetchPrFiles(pr, token?): Promise<{ filename: string; patch?: string }[]>` → `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100` (single page is fine for this scope).
- `buildInlineComments(files, comments)` → `{ inline: {path,line,side:"RIGHT",body}[]; unmapped: ReviewComment[] }`:
  - Map a finding when its `file` matches `filename` and `line != null` and the file's `patch` contains that new-side line number (parse `@@ -a,b +c,d @@` hunks to collect added/context RIGHT line numbers).
  - `body` = ``**[`severity`/`category`] title**\n\ndescription`` + (suggestion ? fenced block).
  - Non-mappable findings → `unmapped`.
- `postReview(pr, token, body, inline)` → `POST /repos/{o}/{r}/pulls/{n}/reviews` with `{ body, event: "COMMENT", comments: inline }`; return `meta.html_url` (PR url). Reuse `GitHubError`.
- Verify: `npm run typecheck`.

### Step 3 — Backend: new endpoints (`backend/src/app.ts`)
- `configSchema` (zod, all optional) merged into `reviewSchema`; pass `config` to `generateReview`.
- `POST /api/review/stream`:
  - Validate body, `parsePrUrl`, `fetchPrData`. Set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`), `res.flushHeaders()`.
  - `await generateReviewStream(info, diff, config, (e) => res.write(\`data: ${JSON.stringify(e)}\n\n\`))`. Send a leading `{type:"pr", pr:info}` event first. End with `res.end()`. On thrown error before headers → JSON 4xx/5xx; after → write `{type:"error"}` then end.
- `POST /api/review/post`:
  - `postSchema = { prUrl: url, githubToken: string.min(1), review: <review shape> }`.
  - `parsePrUrl`; `fetchPrFiles(pr, githubToken)`; `buildInlineComments`; compose review body = `review.summary` + appended unmapped findings; `postReview`. Return `{ url }`.
  - Error mapping like existing handler. **Do not log `githubToken`.**
- Verify: `npm run typecheck`; smoke-run `npm run dev` + curl `/health`.

### Step 4 — Web app scaffold (`web/`)
- `web/package.json` (react, react-dom; dev: @vitejs/plugin-react, vite, typescript, @types/*), scripts `dev`/`build`/`typecheck`.
- `web/tsconfig.json` (DOM libs, react-jsx), `web/vite.config.ts` (react plugin, default SPA), `web/index.html`, `web/src/main.tsx`.
- `web/src/types.ts` — shared types + `ReviewConfig` (copied to keep web deployable standalone).
- `web/src/styles.css` — port [extension styles.css](file:///Users/bytedance/Documents/Projects/code-review/extension/src/sidepanel/styles.css), add a centered `max-width: 880px` container and form styles for selects/PAT.

### Step 5 — Web app logic + UI (`web/src/`)
- `web/src/api.ts`:
  - `streamReview(backendUrl, prUrl, config, onEvent)` — `fetch` POST to `/api/review/stream`, read `res.body` reader, buffer, split on `\n\n`, parse `data:` lines → `onEvent`.
  - `postReview(backendUrl, { prUrl, githubToken, review })` → POST `/api/review/post`.
- `web/src/components/ReviewResult.tsx` + `CommentCard` — ported from extension (no `chrome.*`).
- `web/src/App.tsx`:
  - State: backendUrl (localStorage, default = extension's default Vercel URL), prUrl, config (model/focus/maxComments), status, statusMsg, pr, summary, comments[], error.
  - Review button → reset, `streamReview`, accumulate events into state (live).
  - Settings `<details>`: backend URL, model, focus `<select>`, max comments.
  - Post-to-GitHub block (after `done`): PAT `<input type="password">` + scope hint, preview count, **Post review** button → `postReview`, show success link / error.
- Verify: `cd web && npm install && npm run build`.

### Step 6 — Docs
- [README.md](file:///Users/bytedance/Documents/Projects/code-review/README.md): add **Web app** section (run/build/deploy to Vercel static) + document `/api/review/stream`, `/api/review/post`, config, and the PAT security note.
- [ARCHITECTURE.md](file:///Users/bytedance/Documents/Projects/code-review/ARCHITECTURE.md): add web app component, streaming/chunking/write-back flows; update "Current limitations".

### Step 7 — project_rules.md (per custom instructions)
- If `project_rules.md` exists, update specs to reflect generated code (common scenarios/methods only). Search first; create nothing new unless it already exists.

## Assumptions & Decisions
- PAT per-request, never persisted/logged. Inline review uses line-based Reviews API, event `COMMENT`. SSE via streamed POST body. Chunk-merge by concatenation (no extra LLM call). Extension untouched. No DB.

## Verification
- `cd backend && npm run typecheck` ✓; `npm run dev` + curl `/health` ✓.
- `cd web && npm run build` ✓.
- Manual E2E (real public PR): stream renders live; `focus=security` biases findings; >48k diff merges without truncation marker; post with a valid PAT creates a review with inline comments; empty/bad token → 4xx.
