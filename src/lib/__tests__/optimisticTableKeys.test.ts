import { describe, expect, it, vi } from "vitest";
import { updateWithVersion, VERSIONED_TABLES, type VersionedTable } from "../db/optimisticLock";

describe("optimistic-lock table allowlist", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "subscriptions", "unknown"])(
    "rejects unsupported table %s before calling the client", async (table) => {
      const from = vi.fn();
      await expect(updateWithVersion({ from }, table as VersionedTable, "id", 1, {}))
        .rejects.toThrow("is not a versioned table");
      expect(from).not.toHaveBeenCalled();
    },
  );
  it.each(Object.entries(VERSIONED_TABLES))("keeps the correct key/version filters for %s", async (table, keyColumn) => {
    const row = { [keyColumn]: "one", row_version: 2, field: "value" };
    const select = vi.fn(async () => ({ data: [row], error: null }));
    const eq = vi.fn();
    const query = { eq, select }; eq.mockReturnValue(query);
    const update = vi.fn(() => query);
    const from = vi.fn(() => ({ update }));
    const patch = { field: "value" };
    await expect(updateWithVersion({ from }, table as VersionedTable, "one", 1, patch))
      .resolves.toEqual({ status: "ok", row, rowVersion: 2 });
    expect(from).toHaveBeenCalledWith(table);
    expect(update).toHaveBeenCalledWith(patch);
    expect(eq.mock.calls).toEqual([[keyColumn, "one"], ["row_version", 1]]);
  });
});
