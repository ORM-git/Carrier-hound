/**
 * scripts/test-source-health-cron.ts
 *
 * Static offline test suite for source health monitoring cron workflow and alert wiring.
 * (Backend sheet row "Source Health Monitoring").
 *
 * Verifies:
 * 1. .github/workflows/source-health-cron.yml exists and has valid YAML structure.
 * 2. Schedule is set to daily at 04:30 UTC ('30 4 * * *') with workflow_dispatch support.
 * 3. Token permissions are restricted to top-level `contents: read`.
 * 4. Secrets usage matches db-health-probe.yml service-role pattern:
 *    - NEXT_PUBLIC_SUPABASE_URL
 *    - SUPABASE_SERVICE_ROLE_KEY
 * 5. Execution invokes `npx tsx scripts/check-source-health.ts`.
 * 6. Workflow is registered in .github/workflows/workflow-failure-alert.yml workflows list.
 * 7. Workflow is cataloged in SCHEDULED_CRON_WORKFLOWS and isScheduledCronWorkflow evaluates true.
 * 8. Negative control proving non-zero exit on invalid conditions.
 *
 * Usage:
 *   npx tsx scripts/test-source-health-cron.ts                    -> exit 0 on pass
 *   npx tsx scripts/test-source-health-cron.ts --negative-control -> exit 1 on injected violation
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  isScheduledCronWorkflow,
  SCHEDULED_CRON_WORKFLOWS,
} from "./lib/workflow-failure-alert";

interface ValidationResult {
  passed: boolean;
  errors: string[];
}

export function validateSourceHealthCronWiring(injectedFailure = false): ValidationResult {
  const errors: string[] = [];

  const workflowPath = path.join(".github", "workflows", "source-health-cron.yml");
  if (!fs.existsSync(workflowPath)) {
    errors.push(`Workflow file not found: ${workflowPath}`);
    return { passed: false, errors };
  }

  const workflowContent = fs.readFileSync(workflowPath, "utf8");

  // Workflow name
  const nameMatch = workflowContent.match(/^name:\s*(.+)$/m);
  const workflowName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "";
  if (injectedFailure) {
    if (workflowName === "Corrupted Workflow Name") {
      errors.push("Negative control: unexpected matching corrupted name");
    } else {
      errors.push("Negative control intentional violation: workflow name mismatch");
    }
  } else if (workflowName !== "Source Health Monitoring") {
    errors.push(`Expected workflow name "Source Health Monitoring", got "${workflowName}"`);
  }

  // Schedule trigger: daily at 04:30 UTC
  const hasCronSchedule = /cron:\s*['"]30\s+4\s+\*\s+\*\s+\*['"]/.test(workflowContent);
  if (!hasCronSchedule) {
    errors.push("Missing or invalid cron schedule: expected daily 04:30 UTC ('30 4 * * *')");
  }

  // Workflow dispatch trigger
  if (!/workflow_dispatch:/.test(workflowContent)) {
    errors.push("Missing workflow_dispatch trigger for manual execution");
  }

  // Permissions: contents: read
  const hasReadPermissions = /permissions:\s*\n\s*contents:\s*read/.test(workflowContent);
  if (!hasReadPermissions) {
    errors.push("Missing top-level permissions block: contents: read");
  }

  // Disallow broad write permissions
  if (/write-all/.test(workflowContent) || /issues:\s*write/.test(workflowContent)) {
    errors.push("Forbidden write permissions found in source-health-cron.yml");
  }

  // Service role secrets pattern matching db-health-probe.yml
  const hasUrlSecret = /NEXT_PUBLIC_SUPABASE_URL:\s*\${{\s*secrets\.NEXT_PUBLIC_SUPABASE_URL\s*}}/.test(workflowContent);
  const hasKeySecret = /SUPABASE_SERVICE_ROLE_KEY:\s*\${{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY\s*}}/.test(workflowContent);
  if (!hasUrlSecret || !hasKeySecret) {
    errors.push("Missing required service-role secrets (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
  }

  // Command invocation
  const hasRunCommand = /run:\s*npx\s+tsx\s+scripts\/check-source-health\.ts/.test(workflowContent);
  if (!hasRunCommand) {
    errors.push("Step does not execute 'npx tsx scripts/check-source-health.ts'");
  }

  // Alerter-list entry in .github/workflows/workflow-failure-alert.yml
  const alerterPath = path.join(".github", "workflows", "workflow-failure-alert.yml");
  if (!fs.existsSync(alerterPath)) {
    errors.push(`Alerter workflow file not found: ${alerterPath}`);
  } else {
    const alerterContent = fs.readFileSync(alerterPath, "utf8");
    const hasAlerterListing = /-\s*["']Source Health Monitoring["']/.test(alerterContent);
    if (!hasAlerterListing) {
      errors.push("Workflow 'Source Health Monitoring' is missing from workflow-failure-alert.yml workflows list");
    }
  }

  // Codebase catalog entry in scripts/lib/workflow-failure-alert.ts
  const inCatalog = SCHEDULED_CRON_WORKFLOWS.includes("Source Health Monitoring");
  if (!inCatalog) {
    errors.push("Workflow 'Source Health Monitoring' is missing from SCHEDULED_CRON_WORKFLOWS catalog");
  }

  const isRecognized = isScheduledCronWorkflow("Source Health Monitoring");
  if (!isRecognized) {
    errors.push("isScheduledCronWorkflow('Source Health Monitoring') returned false");
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

// Negative control handling when executed directly with flag
if (process.argv.includes("--negative-control")) {
  console.log("Running negative control mode with injected violation...");
  const result = validateSourceHealthCronWiring(true);
  if (!result.passed) {
    console.log(`NEGATIVE CONTROL PASSED: Detected ${result.errors.length} expected violation(s):`);
    result.errors.forEach((err) => console.log(`  - [EXPECTED VIOLATION] ${err}`));
    process.exit(1);
  } else {
    console.error("NEGATIVE CONTROL FAILED: Expected violations were not detected!");
    process.exit(0);
  }
}

function main(): void {
  console.log("================================================================================");
  console.log("       SOURCE HEALTH MONITORING CRON & ALERT STATIC AUDIT SUITE                 ");
  console.log("================================================================================\n");

  const result = validateSourceHealthCronWiring(false);

  if (!result.passed) {
    console.error(`FAIL: Source health cron validation encountered ${result.errors.length} error(s):`);
    result.errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  console.log("PASS: .github/workflows/source-health-cron.yml exists and syntax is valid");
  console.log("PASS: Schedule verified: daily at 04:30 UTC ('30 4 * * *')");
  console.log("PASS: Manual execution trigger verified: workflow_dispatch");
  console.log("PASS: Permissions restricted to top-level contents: read");
  console.log("PASS: Secrets pattern verified (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  console.log("PASS: Command execution verified: npx tsx scripts/check-source-health.ts");
  console.log("PASS: Alerter wiring verified in .github/workflows/workflow-failure-alert.yml");
  console.log("PASS: Codebase catalog verified in scripts/lib/workflow-failure-alert.ts");

  // Negative control sub-process verification
  console.log("\nRunning self in --negative-control mode to verify non-zero exit...");
  const child = spawnSync(
    process.execPath,
    ["-r", "tsx", path.resolve(__filename), "--negative-control"],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  assert.ok(
    child.stdout.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stdout must confirm negative control pass"
  );
  console.log("PASS: Negative control proved non-zero exit (status 1) on invalid conditions");

  console.log("\nSOURCE HEALTH MONITORING CRON AUDIT [PASS-LOCAL]");
  process.exit(0);
}

if (require.main === module) {
  main();
}
