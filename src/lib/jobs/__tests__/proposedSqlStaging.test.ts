import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The advanced-filter SQL is STAGING ONLY until the owner reviews and applies it by hand. Nothing in
// supabase/migrations may carry it, so no tooling that applies that folder can run it by accident.
describe("advanced filter SQL stays out of supabase/migrations", () => {
  it("20261126b and 20261126c exist only under docs/proposed/executable", () => {
    const applied = fs.existsSync("supabase/migrations") ? fs.readdirSync("supabase/migrations") : [];
    expect(applied.filter((f) => /^20261126[bc]_/.test(f))).toEqual([]);
    expect(fs.existsSync("docs/proposed/executable/20261126b_advanced_preferences_slice1.sql")).toBe(true);
    expect(fs.existsSync("docs/proposed/executable/20261126c_advanced_skill_filter_rpc.sql")).toBe(true);
  });
  it("both files still say NOT APPLIED and keep their READONLY pre-check companions", () => {
    for (const f of ["20261126b_advanced_preferences_slice1.sql", "20261126c_advanced_skill_filter_rpc.sql"]) {
      expect(fs.readFileSync(`docs/proposed/executable/${f}`, "utf8")).toMatch(/NOT APPLIED/i);
    }
    expect(fs.existsSync("docs/proposed/advanced_preferences_slice1.READONLY.sql")).toBe(true);
    expect(fs.existsSync("docs/proposed/advanced_skill_rpc.READONLY.sql")).toBe(true);
  });
});
