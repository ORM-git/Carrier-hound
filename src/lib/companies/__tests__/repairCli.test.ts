import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, rollbackSql } from "../../../../scripts/repair-company-logos";

describe("company-logo-repair workflow (scheduled safety sweep)", () => {
  const wf = fs.readFileSync(path.resolve(__dirname, "../../../../.github/workflows/company-logo-repair.yml"), "utf8");
  it("is inert until LOGO_REPAIR_ENABLED, serialised, capped and never unlimited", () => {
    expect(wf).toMatch(/if: github\.event_name == 'workflow_dispatch' \|\| vars\.LOGO_REPAIR_ENABLED == 'true'/);
    expect(wf).toMatch(/concurrency:\n\s+group: company-logo-repair\n\s+cancel-in-progress: false/);
    expect(wf).toMatch(/\(\( limit < 1 \|\| limit > 200 \)\)/);
    expect(wf).toMatch(/--limit "\$LIMIT"/);
    expect(wf).not.toMatch(/--limit\s*$/m);
    // manual runs default to dry-run; only the gated schedule (or an explicit choice) writes
    expect(wf).toMatch(/default: dry-run/);
    expect(wf).toMatch(/if \[\[ "\$EVENT" == "schedule" \]\]; then mode=write; else mode="\$\{INPUT_MODE:-dry-run\}"; fi/);
  });
});

describe("repair-company-logos CLI guards", () => {
  it("requires an explicit bounded --limit (no empty or unlimited mode)", () => {
    expect(() => parseArgs([])).toThrow(/--limit is required/);
    expect(() => parseArgs(["--limit"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--limit", ""])).toThrow(/integer/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/1\.\.200/);
    expect(() => parseArgs(["--limit", "201"])).toThrow(/1\.\.200/);
    expect(() => parseArgs(["--limit", "all"])).toThrow(/integer/);
    expect(parseArgs(["--limit", "40"])).toMatchObject({ limit: 40, write: false, concurrency: 4, verify: 25, trigger: "sweep" });
  });

  it("bounds concurrency/verify, rejects unknown flags and needs a manifest for a backfill write", () => {
    expect(() => parseArgs(["--limit", "5", "--concurrency", "9"])).toThrow(/1\.\.8/);
    expect(() => parseArgs(["--limit", "5", "--verify", "101"])).toThrow(/0\.\.100/);
    expect(() => parseArgs(["--limit", "5", "--missing-only"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--limit", "5", "--trigger", "cron"])).toThrow(/--trigger/);
    expect(() => parseArgs(["--limit", "5", "--write", "--trigger", "backfill"])).toThrow(/requires --manifest/);
    expect(parseArgs(["--limit", "5", "--write", "--trigger", "backfill", "--manifest", "m.json"])).toMatchObject({ write: true, manifest: "m.json" });
  });

  it("scopes rollback SQL to rows that still hold this run's value", () => {
    const sql = rollbackSql([
      { id: "a", name: "A", status: "repaired", reason: null, source: "ats-board", logoUrl: "https://p/x.png", previousLogoUrl: "https://unavatar.io/a.com", sha256: "s", attempts: 1, nextAttemptAt: null },
      { id: "b", name: "B'Co", status: "missing", reason: "no-source", source: null, logoUrl: null, previousLogoUrl: "https://www.google.com/s2/favicons?domain=b.com", sha256: null, attempts: 1, nextAttemptAt: "x" },
      { id: "c", name: "C", status: "already-eligible", reason: null, source: null, logoUrl: "https://p/c.png", previousLogoUrl: "https://p/c.png", sha256: null, attempts: 0, nextAttemptAt: null },
    ]);
    expect(sql).toContain("SET logo_url = 'https://unavatar.io/a.com', logo_status = NULL WHERE id = 'a' AND logo_url IS NOT DISTINCT FROM 'https://p/x.png';");
    expect(sql).toContain("WHERE id = 'b' AND logo_url IS NOT DISTINCT FROM NULL;");
    expect(sql).not.toContain("id = 'c'");
    expect(sql.trim().startsWith("-- Scoped rollback")).toBe(true);
  });
});
