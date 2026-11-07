# Release Versioning Policy (INTERNAL)

> Backend rows BE#11 (Semantic Versioning) and BE#14 (Git Tags / Releases).
> Decided 2026-11-06, pre-launch.

## Current state

`package.json` is pinned at `1.0.0` and the repo has no version tags. That is
acceptable pre-launch; this policy takes effect at the first tagged release.

## Semantic versioning (BE#11)

1. The app follows semver `MAJOR.MINOR.PATCH` starting at the first public
   launch tag.
2. **MAJOR**: breaking change to the public API contract (see
   `docs/api-versioning.md`), a database migration that is not
   backward-compatible with the previous app version, or a removed feature.
3. **MINOR**: backward-compatible feature or endpoint additions.
4. **PATCH**: backward-compatible fixes, security patches, and internal
   refactors.
5. Pre-launch commits do not bump the version; the version field changes
   only as part of a release commit.
6. Breaking changes while the API is private (per `docs/api-versioning.md`)
   do not require a MAJOR bump until the first public promise is tagged.

## Git tags and releases (BE#14)

1. Every release is a GitHub Release backed by an annotated tag `vX.Y.Z`
   on the merge commit that shipped it (e.g. `git tag -a v1.1.0 -m "v1.1.0"`).
2. The release commit sets `package.json` `version` to `X.Y.Z` (no `v`).
3. Each release notes entry lists: user-facing changes, internal/backend
   changes, database migrations included (with their NOT APPLIED/applied
   status), and any owner follow-up steps.
4. Rollback reference: the previous tag is the known-good deploy target;
   hotfixes branch from the tag, not from main.
5. Tags are created only after the release's CI run is green on main.

## First-release checklist (owner to confirm before launch)

- [ ] Decide launch version (default `1.0.0` stays if nothing public shipped).
- [ ] Tag `v1.0.0` on the launch merge commit.
- [ ] Create the GitHub Release with the notes format above.
