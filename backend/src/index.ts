import "dotenv/config";
import { createApp } from "./app.js";

// Local dev server. On Vercel the app is served via api/index.ts instead.
const app = createApp();
const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`AI Code Review backend listening on http://localhost:${port}`);
});
