import { describe, expect, it } from "vitest";
import { summarizeReindexResults, type ReindexRow } from "../maintenance/reindex";

const row = (action: string, index_name = "jobs_index"): ReindexRow => ({
  schema_name: "public", table_name: "jobs", index_name,
  size_bytes: 60 * 1024 * 1024, size_pretty: "60 MB", action,
});

describe("reindex maintenance result reporting", () => {
  it("reports an empty successful RPC as no candidates, not failed", () => {
    expect(summarizeReindexResults([])).toEqual({
      reindexed: 0, failed: 0, status: "success", errorMessage: null,
    });
  });
  it("does not count dry-run candidates as completed rebuilds", () => {
    expect(summarizeReindexResults([row("would_reindex"), row("would_reindex")])).toEqual({
      reindexed: 0, failed: 0, status: "success", errorMessage: null,
    });
  });
  it("reports successful rebuilds without a failure message", () => {
    expect(summarizeReindexResults([row("reindexed"), row("reindexed")])).toEqual({
      reindexed: 2, failed: 0, status: "success", errorMessage: null,
    });
  });
  it("marks partial failure failed while preserving successful rebuild count and input", () => {
    const rows = Object.freeze([Object.freeze(row("reindexed")), Object.freeze(row("failed", "other"))]);
    expect(summarizeReindexResults(rows)).toEqual({
      reindexed: 1, failed: 1, status: "failed", errorMessage: "1 of 2 index maintenance operations failed",
    });
    expect(rows[1].action).toBe("failed");
  });
  it("marks all failures failed without claiming a rebuild succeeded", () => {
    expect(summarizeReindexResults([row("failed"), row("failed")])).toEqual({
      reindexed: 0, failed: 2, status: "failed", errorMessage: "2 of 2 index maintenance operations failed",
    });
  });
});
