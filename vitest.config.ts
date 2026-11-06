import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      reporter: ["text", "json-summary"],
      // Ratchet baseline measured on main 2026-11-06 (audit BE #13):
      // lines 1.44 / statements 1.44 / functions 29.59 / branches 42.55.
      // The gate blocks backsliding only; raise the thresholds as unit
      // suites grow (same pattern as the bundle-size budget in #285).
      thresholds: {
        lines: 1.4,
        statements: 1.4,
        functions: 29,
        branches: 42,
      },
    },
  },
});
