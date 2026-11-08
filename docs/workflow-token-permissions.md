# GitHub Actions token permissions (Backend sheet row: Least-privilege Access Tokens)

Status: repo-side guard and inventory. It does not change any workflow, token or secret. The row stays
PARTIAL: the service-role key that powers the cron workflows is not audited here.

Pieces: `scripts/test-workflow-permissions.ts` (offline, registered), the workflow files under
`.github/workflows/`.

## What is checked (repo evidence)

- Files with a top-level `permissions:` block declare `contents: read` first. Seven workflows do
  (`board-ingest`, `capacity-report-cron`, `dunning-dispatch-cron`, `inbound-poll-cron`, `plan-regression`,
  `quality-advisory`, `security-scan`).
- The only write permission is `checks: write` in `security-scan.yml`. It is on an allowlist in the test.
- No workflow uses `write-all`, the `pull_request_target` trigger, or a hard-coded token-looking value.
- Five workflows have no top-level `permissions:` block: `ci.yml`, `daily-digest-cron.yml`,
  `early-access-digest-cron.yml`, `ingest.yml`, `retention-cron.yml`. They run with the repository's default
  workflow-token permissions, which the repo cannot show. The test keeps this list as an exact baseline, so a
  new workflow without permissions fails, and a fixed one must be removed from the list.

## Why the five are not fixed here

Adding `permissions: contents: read` to a workflow edits a file that `scripts/config-drift-baseline.json`
pins by hash (`docs/config-drift.md`), and any workflow change should be reviewed on its own. Each of the five
only checks out the repo and sets up Node, so `contents: read` looks sufficient, but that has not been run
(owner to confirm).

## What this does NOT cover (unproven)

- The repository default for workflow tokens (Settings, Actions, General, Workflow permissions). The repo
  cannot see it.
- Scope of the secrets the crons use. The service-role key gives full database access to the cron scripts;
  a narrower key or a dedicated database role has not been designed or audited.
- Third-party action pinning: actions are referenced by version tag, not commit SHA.
- Personal access tokens or deploy keys held outside the repo.

## Owner steps (for the keeper's Doc)

1. In GitHub, set the default workflow permissions to read-only (a repository setting).
2. Approve a small PR that adds `permissions: contents: read` to the five workflows and regenerates the
   config-drift baseline.
3. Review which cron scripts really need the service-role key, and whether a narrower database role is worth
   creating.
4. Decide whether to pin third-party actions by commit SHA.
