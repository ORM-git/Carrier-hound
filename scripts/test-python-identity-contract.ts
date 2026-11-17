/**
 * scripts/test-python-identity-contract.ts
 *
 * Runs the Python identity contract test suite (scripts/scraper/test_identity_contract.py)
 * and asserts that it passes 100% of language-neutral golden test cases and validations.
 */

import { spawnSync } from "child_process";
import * as path from "path";

export async function runPythonIdentityContract(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  const testScript = path.resolve(__dirname, "scraper/test_identity_contract.py");

  // Try python then python3
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  let executed = false;
  let lastError: Error | null = null;
  let lastOutput = "";

  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, [testScript], {
        cwd: repoRoot,
        env: { ...process.env, PYTHONPATH: repoRoot },
        encoding: "utf8",
      });

      if (res.error) {
        lastError = res.error;
        continue;
      }

      lastOutput = res.stdout || res.stderr;
      if (res.status === 0) {
        executed = true;
        console.log(`[PASS] Python identity contract tests passed via ${cmd}:`);
        console.log(res.stdout.trim());
        break;
      } else {
        throw new Error(`Python identity contract test exited with status ${res.status}:\n${res.stdout}\n${res.stderr}`);
      }
    } catch (err: any) {
      lastError = err;
      if (err.message?.includes("exited with status")) {
        throw err;
      }
    }
  }

  if (!executed) {
    throw new Error(`Failed to execute Python test via any python binary candidate: ${lastError?.message || lastOutput}`);
  }
}

if (require.main === module) {
  runPythonIdentityContract()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
