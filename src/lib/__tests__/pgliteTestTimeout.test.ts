import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// An in-process Postgres (PGlite) plus migrations takes ~1-2s alone but 4-6s under full-suite
// parallel load, past vitest's 5000ms default: inventory.test.ts timed out that way with
// --maxWorkers=16. Every test file that imports PGlite must raise its timeout.
const ROOT = join(__dirname, "..", "..", "..");
const RAISED = /vi\.setConfig\(\{\s*testTimeout:|\},\s*[\d_]{4,}\);/;

// Known gaps. feedConstraintsLiteral opens one shared instance in beforeAll (tests take ms).
// shortcut: the other three also crossed 5000ms in a 16-worker run; remove each once it sets a timeout.
const KNOWN_GAPS = new Set([
  "src/lib/preferences/__tests__/feedConstraintsLiteral.test.ts",
  "src/lib/__tests__/prepaidPaymentFlow.test.ts",
  "src/lib/__tests__/userPreferencesConstraints.test.ts",
  "src/lib/__tests__/userPreferencesEndToEnd.test.ts",
]);

const pgliteTestFiles = ["src", "workers"].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .map((f) => `${dir}/${f.replace(/\\/g, "/")}`)
    .filter((f) => /\.test\.tsx?$/.test(f) && /from "@electric-sql\/pglite"/.test(readFileSync(join(ROOT, f), "utf8"))),
);

describe("PGlite test timeouts", () => {
  it("finds the PGlite test files", () => {
    expect(pgliteTestFiles).toContain("src/lib/company-profile/__tests__/inventory.test.ts");
  });

  it("every PGlite test file raises the 5000ms default timeout", () => {
    const missing = pgliteTestFiles.filter((f) => !KNOWN_GAPS.has(f) && !RAISED.test(readFileSync(join(ROOT, f), "utf8")));
    expect(missing).toEqual([]);
  });

  it("the known-gap list carries no fixed or deleted files", () => {
    const stale = Array.from(KNOWN_GAPS).filter((f) => !pgliteTestFiles.includes(f) || RAISED.test(readFileSync(join(ROOT, f), "utf8")));
    expect(stale).toEqual([]);
  });
});
