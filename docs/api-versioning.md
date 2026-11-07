# API Versioning Policy (INTERNAL)

> Backend row BE#10. Decided 2026-11-06, before any public API promise.

## Current state

All routes are unversioned `/api/*` and the API is private (first-party web
app + internal crons only). This is acceptable while no external consumer
exists.

## Policy

1. **While private**: routes stay unversioned. Breaking changes are allowed
   but must ship with the consuming frontend in the same release.
2. **First public promise** (partner, public docs, or third-party client):
   freeze the current surface as `/api/v1/*` (path prefix). The unversioned
   routes keep working for the first-party app and are not a public
   contract.
3. **Breaking changes to a public version** require a new prefix
   (`/api/v2/*`). Non-breaking additive changes (new fields, new endpoints)
   go into the current version.
4. **Deprecation**: a retiring version gets a written deprecation notice in
   the changelog and a minimum 90-day overlap window before removal.
5. **Version-negotiation headers** (`Accept-Version` etc.) are explicitly
   NOT used; path prefixes only, for cache simplicity on Cloudflare.

## Signals that trigger step 2

- Any route documented for external use (see `docs/openapi.yaml`).
- Any API key or webhook secret issued to a third party.
