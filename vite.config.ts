import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { githubPagesBase } from "./src/lib/basePath.ts";

export default defineConfig({
  base: githubPagesBase(process.env.GITHUB_REPOSITORY),
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: true,
    target: "es2020",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
