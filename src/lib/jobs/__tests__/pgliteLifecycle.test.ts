// Static guard: a PGlite instance is a full WASM Postgres (~250 MB resident each, measured locally). Instances that are
// never closed stay alive for the whole worker, so a file opening one per test can push a Vitest worker past 1.5 GB and
// slow every other suite sharing the machine. Every file in this directory that opens PGlite must close what it opens.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => /\.test\.tsx?$/.test(f) && f !== "pgliteLifecycle.test.ts");

describe("PGlite instances opened by src/lib/jobs/__tests__ are closed", () => {
  const openers = files.filter((f) => /new PGlite\(/.test(fs.readFileSync(path.join(DIR, f), "utf8")));

  it("the guard sees the PGlite suites (not vacuous)", () => {
    expect(openers.length).toBeGreaterThanOrEqual(4);
  });

  it.each(openers)("%s closes every instance it opens", (f) => {
    const src = fs.readFileSync(path.join(DIR, f), "utf8");
    // Either each instance is registered for closing, or the file closes its one shared instance in afterAll.
    const opened = src.match(/new PGlite\(/g)!.length;
    const tracked = (src.match(/track\(new PGlite\(/g) ?? []).length;
    const sharedClosedAfterAll = /afterAll\([^)]*\)?\s*=>[\s\S]{0,120}\.close\(\)/.test(src);
    expect(tracked === opened || (opened === 1 && sharedClosedAfterAll), `${f}: ${opened} opened, ${tracked} tracked`).toBe(true);
    if (tracked) expect(src).toMatch(/afterEach\(async \(\) => \{\s*await Promise\.all\(opened\.splice\(0\)\.map\(\(p\) => p\.close\(\)\)\)/);
  });
});
