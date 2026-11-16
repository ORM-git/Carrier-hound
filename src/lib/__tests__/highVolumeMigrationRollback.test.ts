/**
 * src/lib/__tests__/highVolumeMigrationRollback.test.ts
 *
 * Executes forward migration 20261116a and extracted rollback SQL on a real
 * in-process PostgreSQL database (PGlite) populated with legacy and vendor-valued fixtures.
 *
 * Asserts:
 * 1. jobs_public restores cleanly with transactional DROP VIEW + CREATE VIEW.
 * 2. Compatible expanded source_type check is preserved in rollback without violating vendor rows.
 * 3. Old app queries on jobs & jobs_public work and all data (legacy + vendor) remains.
 * 4. Additive columns and backfills are preserved.
 */

import { describe, it, expect } from "vitest";
import { runMigrationRollbackFixtureTest } from "../../../scripts/test-postgres-migration-rollback-fixture";

describe("High-Volume Ingestion Schema: Forward & Rollback SQL Execution on Populated Postgres Fixture", () => {
  it("executes forward migration, ingests vendor rows, executes rollback SQL, and verifies queries & data integrity", async () => {
    await expect(runMigrationRollbackFixtureTest()).resolves.not.toThrow();
  });
});
