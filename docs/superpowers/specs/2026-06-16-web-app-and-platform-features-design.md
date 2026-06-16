# Design — Web App + AI Code Reviewer Platform Features

Date: 2026-06-16

## Summary

Extend the existing AI Code Review project (backend proxy + Chrome extension) with:

1. A standalone **web app** (`web/`) where a user pastes a GitHub PR link and views the AI review in the browser — no extension required.
2. New AI-code-reviewer platform capabilities:
   - **Post review back to GitHub** as a Pull Request Review with inline comments, authenticated by a user-supplied Personal Access Token (PAT).
   - **Streaming** review results via Server-Sent Events (SSE) so progress is visible on large PRs.
   - **Large-diff chunking (map-reduce)** to replace the current hard truncation.
   - **Review configuration** — choose model, focus area, and max comments per request.

The existing backend stays the single source of truth; the extension is unchanged functionally.

## Current State Analysis

- **Backend** (`backend/`): Express + TypeScript, stateless. `POST /api/review { prUrl }` →
  `parsePrUrl` + `fetchPrData` (`github.ts`) → `generateReview` (`review.ts`, single OpenAI call, JSON mode) → `{ pr, review }`.
  - `review.ts` truncates diffs over `MAX_DIFF_CHARS` (48k).
  - `github.ts` only reads PR metadata + unified diff (public repos).
  - `app.ts` defines CORS, `/health`, `POST /api/review`. Validates with `zod`.
- **Extension** (`extension/`): React + Vite MV3 side panel. `App.tsx` detects PR URL, calls backend, renders `ReviewResult.tsx`. Types in `types.ts`. Dark GitHub-style CSS in `styles.css`.
- No web app, no DB, no write-back, no streaming, no chunking, no per-request config.

## Proposed Changes

### A. Backend

#### A1. `backend/src/review.ts` — config, chunking, streaming-friendly API
- Add a `ReviewConfig` type: `{ model?: string; focus?: "all" | "correctness" | "security" | "quality" | "performance"; maxComments?: number }`.
- `generateReview(info, diff, config?)`:
  - Build the system prompt with the focus area injected (when `focus !== "all"`, instruct the model to prioritize/limit to that category).
  - If `diff.length <= MAX_DIFF_CHARS`: single call as today.
  - Else: **chunk by file** — split the unified diff on `diff --git` boundaries, greedily pack hunks into chunks under `MAX_DIFF_CHARS`, review each chunk in parallel (bounded concurrency, e.g. 3), then **merge**: concatenate/condense summaries into one summary (a final lightweight merge call OR simple concatenation — use concatenation to avoid an extra call), and flatten + cap comments at `maxComments` (default 50), sorted by severity.
  - Add a `splitDiffByFile(diff): string[]` helper.
- Add `generateReviewStream(info, diff, config, onEvent)` that emits events: `{ type: "status", message }`, `{ type: "summary", summary }`, `{ type: "comment", comment }`, `{ type: "done", review }`, `{ type: "error", error }`. For chunked reviews, emit a status per chunk and stream comments as each chunk completes. (For the single-call path, it can run the call then emit summary + comments.)

#### A2. `backend/src/github.ts` — files + write-back
- Add `fetchPrFiles(pr, token?)` → GitHub `GET .../pulls/{n}/files` returning `[{ filename, patch }]`. Used to map a finding's `(file, line)` to a valid review `position`/`line` for inline comments.
- Add `postReview(pr, token, payload)` → `POST .../pulls/{n}/reviews` with `{ body, event: "COMMENT", comments: [{ path, line, side: "RIGHT", body }] }`. Inline comments use the new line-based Reviews API (`line` + `side`), which is simpler than computing `position`. Findings whose line cannot be validated against the changed lines are appended to the review `body` instead of being dropped.
- `authHeaders` already supports a token via env; add an overload/param so a **request-supplied token** takes precedence over `GITHUB_TOKEN` for write calls.

#### A3. `backend/src/app.ts` — new endpoints
- Extend `reviewSchema` to accept optional `config` (`model`, `focus`, `maxComments`) validated by `zod`.
- `POST /api/review` — pass `config` through to `generateReview`.
- `POST /api/review/stream` — SSE. Set headers (`text/event-stream`, `no-cache`, `keep-alive`), fetch PR data, call `generateReviewStream`, write each event as `data: <json>\n\n`, end on `done`/`error`. Reuse the same validation.
- `POST /api/review/post` — body `{ prUrl, githubToken, review }` (zod-validated; `githubToken` required, non-empty). Fetch PR files, build inline comments via the line-mapping helper, call `postReview`. Return `{ url }` (the created review/PR URL). On GitHub error, map status as the existing handler does. **Never log the token.**

#### A4. Helper: line mapping (`backend/src/github.ts` or new `mapping.ts`)
- `buildInlineComments(files, comments)`:
  - For each finding with a non-null `line` and a matching file whose `patch` contains that line on the RIGHT side, produce `{ path, line, side: "RIGHT", body }` where `body` = `**[severity/category] title**\n\ndescription` + optional suggestion block.
  - Findings without a mappable line → returned separately to be appended to the review body.

### B. Web app (`web/`) — new React + Vite SPA

Mirror the extension's stack (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`).

- `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts` (standard SPA build, no MV3 entries), `web/index.html`.
- `web/src/main.tsx` — React bootstrap.
- `web/src/App.tsx`:
  - PR URL input + **Review** button. On submit, open SSE to `/api/review/stream` (via `fetch` + `ReadableStream` reader, since `EventSource` can't POST — use a `fetch` POST and parse the streamed body). Show live status, then summary, then findings as they arrive.
  - **Settings** (`details`): backend URL (persisted to `localStorage`), model, focus (`select`), max comments.
  - **Post to GitHub** section (shown after a review): PAT input (`type="password"`, scope hint "needs `repo` or `pull_request` write"), a short preview ("Will post 1 summary + N inline comments"), and a **Post review** button → `POST /api/review/post`. Show success link or error.
- `web/src/components/` — `ReviewResult.tsx` + `CommentCard` ported from the extension (plain React, no `chrome.*`).
- `web/src/types.ts` — copy of the shared types, extended with `ReviewConfig`.
- `web/src/api.ts` — `streamReview()`, `postReview()` fetch helpers and SSE-line parsing.
- `web/src/styles.css` — reuse/adapt the extension's dark theme, widened for a full page (max-width container).

### C. Docs
- Update `README.md`: add a "Web app" section (run/build/deploy) and document the new endpoints + features.
- Update `ARCHITECTURE.md`: add the web app component, the streaming + chunking + write-back flows, and update "Current limitations".

## Assumptions & Decisions

- **PAT, not OAuth** — token supplied per request from the web app, used immediately for the GitHub write call, never persisted or logged. Documented as a security note.
- **Inline comments via line-based Reviews API** (`line` + `side: "RIGHT"`), event `COMMENT` (not `APPROVE`/`REQUEST_CHANGES`) to stay neutral. Unmappable findings appended to the review body.
- **SSE over WebSockets** — one-way, simpler, works on serverless. Web app reads the streamed POST response body (not `EventSource`, which is GET-only).
- **Chunking merges by concatenation** (no extra merge LLM call) to control cost; comments capped + severity-sorted.
- **Streaming on Vercel**: SSE works on Vercel Node serverless functions with appropriate headers; acceptable for this scope. Local `npm run dev` is the primary test path.
- The extension is **not** modified beyond optionally benefiting from the same backend; no breaking changes to `/api/review`.
- No database — review history persistence was explicitly out of scope for this iteration.

## Verification

- Backend: `cd backend && npm run typecheck` passes. Manual:
  - `POST /api/review/stream` against a public PR streams `status`/`summary`/`comment`/`done` events.
  - `POST /api/review` with `config.focus="security"` biases findings.
  - Large PR (> 48k diff) returns merged multi-chunk review without truncation marker.
  - `POST /api/review/post` with a real PAT on a test PR creates a review with inline comments; bad/empty token → 4xx; never logs the token.
- Web app: `cd web && npm run build` succeeds. Manual end-to-end: paste PR → live stream renders → enter PAT → post → success link opens the PR review.
