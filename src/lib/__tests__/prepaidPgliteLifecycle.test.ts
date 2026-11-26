import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Runs the real PGlite integration group of prepaidPaymentFlow.test.ts in a child
// vitest with an injected failure, then checks every instance it opened was closed.
// The child failures are expected and asserted here; they never reach this suite.
const PAYMENT_TEST = "src/lib/__tests__/prepaidPaymentFlow.test.ts";
const TEST_TIMEOUT_MS = 60_000;
// spawnSync blocks the worker, so vitest's own timeout cannot interrupt it; this bound
// leaves 15s of margin for the kill, output collection and the failure report.
const CHILD_TIMEOUT_MS = 45_000;

/** Runs a node child to completion or throws an actionable error; never returns a timed-out run. */
function runBoundedChild(args: string[], env: NodeJS.ProcessEnv, timeoutMs = CHILD_TIMEOUT_MS) {
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (child.error || child.signal || child.status === null) {
    throw new Error(
      `lifecycle child did not finish within ${timeoutMs}ms ` +
        `(error=${child.error?.message ?? "none"}, signal=${child.signal ?? "none"}, status=${child.status})\n${output}`,
    );
  }
  return { status: child.status, output };
}

function runFaulted(fault: "setup" | "assert", testName: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-lifecycle-"));
  try {
    const log = path.join(dir, "log.txt");
    fs.writeFileSync(log, "");
    const env: NodeJS.ProcessEnv = { ...process.env, PREPAID_PGLITE_FAULT: fault, PREPAID_PGLITE_LIFECYCLE_LOG: log };
    for (const key of Object.keys(env)) if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
    const run = runBoundedChild(
      [path.resolve("node_modules/vitest/vitest.mjs"), "run", PAYMENT_TEST, "-t", testName, "--coverage.enabled=false"],
      env,
    );
    return { ...run, events: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("prepaid PGlite integration lifecycle", () => {
  it("closes the instance when setup fails after bootstrap SQL", () => {
    const run = runFaulted("setup", "grants exact 7, 30, and 90 days");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("lifecycle fault injection: setup failure");
    expect(run.events).toEqual(["opened", "closed=true"]);
  }, TEST_TIMEOUT_MS);

  it("closes the instance when a test assertion fails", () => {
    const run = runFaulted("assert", "lifecycle fault injection: failing assertion");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("lifecycle fault injection: failing assertion");
    expect(run.events).toEqual(["opened", "closed=true"]);
  }, TEST_TIMEOUT_MS);

  it("turns a stalled child into a failure instead of an expected-failure pass", () => {
    const started = Date.now();
    expect(() => runBoundedChild(["-e", "setInterval(() => {}, 1000)"], process.env, 500)).toThrow(
      /did not finish within 500ms/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
