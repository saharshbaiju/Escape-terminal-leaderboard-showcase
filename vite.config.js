import { defineConfig } from "vite";

// Static showcase site — builds to dist/, served by Vercel. No backend.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2020" },
});
