// Vercel serverless entry point.
// The Vercel build runs `pnpm build` first (tsc -> dist/), then bundles this
// file. We import the already-compiled Express app from dist/ so there are no
// TypeScript/extension resolution surprises in the serverless bundler.
import { createApp } from "../dist/app.js";

export default createApp();
