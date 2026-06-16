import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard single-page app build. Output to dist/ for static hosting (Vercel,
// Netlify, GitHub Pages, etc.).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
