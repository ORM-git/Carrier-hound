# GitHub Actions token permissions (Backend sheet row: Least-privilege Access Tokens)

Status: explicit read-only workflow token defaults plus offline inventory guard.
The five formerly inherited defaults now declare `contents: read`; no repository
setting, token, secret, cron schedule or workflow activation was changed. The
row remains PARTIAL: service-role secret scope and live execution are separate.

Pieces: `scripts/test-workflow-permissions.ts` (offline, registered), the workflow
files under `.github/workflows/`, and the regenerated config-drift baseline.

## What is checked (repo evidence)

- Every workflow declares top-level `contents: read`. Unspecified token scopes
  are disabled rather than inherited from a potentially broader repo default.
- The only declared write permission remains `checks: write` in
  `security-scan.yml`, covered by the existing test allowlist.
- No workflow uses `write-all`, `pull_request_target`, or a hard-coded token.
- The repaired workflows are `ci.yml`, `daily-digest-cron.yml`,
  `early-access-digest-cron.yml`, `ingest.yml`, and `retention-cron.yml`. Their
  checkout, Node setup and scripts need repository reads, not GitHub writes.
  Their service credentials are independent of GITHUB_TOKEN permissions.
- The missing-permissions baseline is empty: a future workflow that omits the
  declaration fails the registered guard. Covered hashes were regenerated in
  the same change; a hash update is not a claim of a live run.

## What this does NOT cover (unproven)

- The repository default for workflow tokens (Settings, Actions, General, Workflow permissions). The repo
  cannot see it.
- Scope of the secrets the crons use. The service-role key gives full database access to the cron scripts;
  a narrower key or a dedicated database role has not been designed or audited.
- Third-party action pinning: actions are referenced by version tag, not commit SHA.
- Personal access tokens or deploy keys held outside the repo.

## Owner steps (for the keeper's Doc)

1. In GitHub, set the default workflow permissions to read-only (a repository setting).
2. Verify successful CI and the next intended cron runs after the explicit
   read-only permission change. Do not dispatch live crons just for this check.
3. Review which cron scripts really need the service-role key, and whether a narrower database role is worth
   creating.
4. Decide whether to pin third-party actions by commit SHA.
