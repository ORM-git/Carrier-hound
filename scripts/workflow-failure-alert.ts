/**
 * Entrypoint script for .github/workflows/workflow-failure-alert.yml
 *
 * Reads event metadata from environment variables passed by GitHub Actions,
 * invokes processWorkflowAlert, dispatches Sentry alert, and creates/updates
 * the daily deduped GitHub issue.
 */

import {
  processWorkflowAlert,
  ExistingIssueSummary,
  WorkflowRunEvent,
} from "./lib/workflow-failure-alert";

async function main(): Promise<void> {
  const workflowName = process.env.WORKFLOW_NAME || "";
  const conclusion = process.env.RUN_CONCLUSION || "failure";
  const runUrl = process.env.RUN_URL || "";
  const runId = process.env.RUN_ID || "";
  const createdAt = process.env.RUN_CREATED_AT || new Date().toISOString();
  const repo = process.env.GITHUB_REPOSITORY || "ORM-git/Carrier-hound";
  const token = process.env.GITHUB_TOKEN || "";

  console.log(`[workflow-failure-alert] Event received:`);
  console.log(`  Workflow:   ${workflowName}`);
  console.log(`  Conclusion: ${conclusion}`);
  console.log(`  Run URL:    ${runUrl}`);
  console.log(`  Run ID:     ${runId}`);
  console.log(`  Created At: ${createdAt}`);

  const event: WorkflowRunEvent = {
    workflowName,
    conclusion,
    runUrl,
    runId,
    createdAt,
    repository: repo,
  };

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Carrier-hound-Cron-Failure-Alerter",
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const findExistingIssue = async (title: string): Promise<ExistingIssueSummary | null> => {
    if (!token) return null;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=50`, {
        headers,
      });
      if (!res.ok) return null;
      const issues = (await res.json()) as Array<{ number: number; title: string; body: string; state: string }>;
      const match = issues.find((i) => i.title === title);
      return match ? { number: match.number, title: match.title, body: match.body, state: match.state } : null;
    } catch (err) {
      console.error(`[workflow-failure-alert] Failed to query existing issues (fail-open):`, err);
      return null;
    }
  };

  const createIssue = async (title: string, body: string): Promise<{ number: number }> => {
    if (!token) return { number: 0 };
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        labels: ["cron-failure", "automated"],
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create issue: HTTP ${res.status}`);
    }
    const created = (await res.json()) as { number: number };
    console.log(`[workflow-failure-alert] Created issue #${created.number}`);
    return created;
  };

  const updateIssue = async (issueNumber: number, body: string): Promise<{ number: number }> => {
    if (!token) return { number: issueNumber };
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body, state: "open" }),
    });
    if (!res.ok) {
      throw new Error(`Failed to update issue #${issueNumber}: HTTP ${res.status}`);
    }
    console.log(`[workflow-failure-alert] Updated issue #${issueNumber}`);
    return { number: issueNumber };
  };

  const result = await processWorkflowAlert(event, {
    findExistingIssue,
    createIssue,
    updateIssue,
  });

  console.log(`[workflow-failure-alert] Result:`, JSON.stringify(result, null, 2));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error(`[workflow-failure-alert] Fatal error (fail-open):`, err);
    process.exit(0); // Fail-open: do not fail the alerter workflow itself
  });
}
