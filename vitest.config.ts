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
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      reporter: ["text", "json-summary"],
      // Ratchet baseline measured on main 2026-11-10 (sheet row Coverage Thresholds):
      // lines 15.90 / statements 15.90 / functions 50.40 / branches 72.45.
      // The gate blocks backsliding only; raise the thresholds as unit
      // suites grow (same pattern as the bundle-size budget in #285).
      thresholds: {
        lines: 15.8,
        statements: 15.8,
        functions: 50,
        branches: 72,
      },
    },
  },
});
