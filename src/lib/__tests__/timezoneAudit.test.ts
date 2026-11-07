/**
 * Database row "Timezone Handling" (no global TZ audit): keeps the
 * timezone audit in docs/timezone-audit.md truthful against the real
 * files it cites, so the audit cannot rot away from the code.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";

const doc = fs.readFileSync("docs/timezone-audit.md", "utf8");

describe("timezone audit doc", () => {
  it("documents UTC ISO storage against the real call sites", () => {
    expect(doc).toContain("toISOString()");
    for (const p of [
      "src/lib/admin/analytics.ts",
      "src/lib/account/exportHandler.ts",
      "src/lib/resume/storage.ts",
      "src/lib/observability/logger.ts",
    ]) {
      const src = fs.readFileSync(p, "utf8");
      expect(src.includes("toISOString()"), `${p} keeps UTC ISO timestamps`).toBe(true);
    }
  });

  it("documents the exact-string posted_at contract against cursor.ts", () => {
    const cursor = fs.readFileSync("src/lib/pagination/cursor.ts", "utf8");
    expect(doc).toContain("POSTED_AT_REGEX");
    expect(cursor).toContain("Never re-serializes via new Date().toISOString()");
    expect(/1970 \|\| parsedYear > 2100|1970 \|\| .* 2100/.test(cursor.replace(/\s+/g, " "))).toBe(true);
  });

  it("documents the cron schedules against the real workflow files", () => {
    const checks: Array<[string, string]> = [
      [".github/workflows/early-access-digest-cron.yml", "0 18 * * *"],
      [".github/workflows/dunning-dispatch-cron.yml", "30 4 * * *"],
      [".github/workflows/capacity-report-cron.yml", "0 5 * * 1"],
      [".github/workflows/daily-digest-cron.yml", "30 21 * * *"],
    ];
    for (const [file, cron] of checks) {
      const yml = fs.readFileSync(file, "utf8");
      expect(yml.includes(cron), `${file} keeps cron ${cron}`).toBe(true);
      expect(doc).toContain(cron);
    }
  });

  it("documents the IST digest SLO against docs/slo.md", () => {
    const slo = fs.readFileSync("docs/slo.md", "utf8");
    expect(slo).toContain("00:30 IST");
    expect(doc).toContain("00:30 IST");
  });

  it("keeps server code free of local wall-clock date construction", () => {
    // new Date(year, month, ...) interprets fields in LOCAL time; the
    // audit's rule forbids it in shared server libs.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.includes("__tests__")) files.push(p);
      }
    };
    walk("src/lib");
    for (const p of files) {
      const src = fs.readFileSync(p, "utf8");
      expect(/new Date\(\s*\d{4}\s*,/.test(src), `${p} must not build local wall-clock Dates`).toBe(false);
    }
  });
});
