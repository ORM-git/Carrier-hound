import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Runs the real PGlite integration group of prepaidPaymentFlow.test.ts in a child
// vitest with an injected failure, then checks every instance it opened was closed.
// The child failures are expected and asserted here; they never reach this suite.
const PAYMENT_TEST = "src/lib/__tests__/prepaidPaymentFlow.test.ts";

function runFaulted(fault: "setup" | "assert", testName: string) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-lifecycle-")), "log.txt");
  fs.writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = { ...process.env, PREPAID_PGLITE_FAULT: fault, PREPAID_PGLITE_LIFECYCLE_LOG: log };
  for (const key of Object.keys(env)) if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
  const child = spawnSync(
    process.execPath,
    [path.resolve("node_modules/vitest/vitest.mjs"), "run", PAYMENT_TEST, "-t", testName, "--coverage.enabled=false"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  const events = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
  return { status: child.status, output: `${child.stdout}${child.stderr}`, events };
}

describe("prepaid PGlite integration lifecycle", () => {
  it("closes the instance when setup fails after bootstrap SQL", () => {
    const run = runFaulted("setup", "grants exact 7, 30, and 90 days");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("lifecycle fault injection: setup failure");
    expect(run.events).toEqual(["opened", "closed=true"]);
  }, 60_000);

  it("closes the instance when a test assertion fails", () => {
    const run = runFaulted("assert", "lifecycle fault injection: failing assertion");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("lifecycle fault injection: failing assertion");
    expect(run.events).toEqual(["opened", "closed=true"]);
  }, 60_000);
});
