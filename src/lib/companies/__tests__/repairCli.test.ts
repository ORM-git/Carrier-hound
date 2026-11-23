import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeps, parseArgs, reviewedWriteCommand, rollbackSql } from "../../../../scripts/repair-company-logos";
import { repairCompanyLogo } from "../logoRepair";
import { makePng } from "./pngFixture";

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
    expect(wf).toMatch(/if \[\[ "\$EVENT" == "schedule" \]\]; then mode=write; verify=25; else mode="\$\{INPUT_MODE:-dry-run\}"; verify="\$\{INPUT_VERIFY:-0\}"; fi/);
  });

  it("manual runs default to no verification pass; the schedule cap falls back to LOGO_REPAIR_LIMIT or 20", () => {
    expect(wf).toMatch(/verify:\n\s+description: [^\n]+\n\s+required: true\n\s+default: '0'/);
    expect(wf).toMatch(/limit="\$\{INPUT_LIMIT:-\$\{VAR_LIMIT:-20\}\}"/);
    expect(wf).toMatch(/\(\( verify > 100 \)\)/);
    expect(wf).toMatch(/--verify "\$VERIFY"/);
    expect(wf).not.toMatch(/--verify 25/);
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

  it("scopes rollback SQL to rows that still hold this run's value and are not under owner review", () => {
    const sql = rollbackSql([
      { id: "a", name: "A", status: "repaired", reason: null, source: "ats-board", logoUrl: "https://p/x.png", previousLogoUrl: "https://unavatar.io/a.com", sha256: "s", attempts: 1, nextAttemptAt: null },
      { id: "b", name: "B'Co", status: "missing", reason: "no-source", source: null, logoUrl: null, previousLogoUrl: "https://www.google.com/s2/favicons?domain=b.com", sha256: null, attempts: 1, nextAttemptAt: "x" },
      { id: "c", name: "C", status: "already-eligible", reason: null, source: null, logoUrl: "https://p/c.png", previousLogoUrl: "https://p/c.png", sha256: null, attempts: 0, nextAttemptAt: null },
    ]);
    expect(sql).toContain("SET logo_url = 'https://unavatar.io/a.com', logo_status = NULL WHERE id = 'a' AND logo_url IS NOT DISTINCT FROM 'https://p/x.png' AND NOT public.company_logo_blocked('a');");
    expect(sql).toContain("WHERE id = 'b' AND logo_url IS NOT DISTINCT FROM NULL AND NOT public.company_logo_blocked('b');");
    expect(sql).not.toContain("id = 'c'");
    expect(sql.trim().startsWith("-- Scoped rollback")).toBe(true);
  });
});

describe("manifest-scoped runs never touch other companies", () => {
  it("--manifest forces --verify 0 (the verification pass is unscoped)", () => {
    expect(parseArgs(["--limit", "5", "--manifest", "m.json"]).verify).toBe(0);
    expect(() => parseArgs(["--limit", "5", "--manifest", "m.json", "--verify", "25"])).toThrow(/--verify 0/);
    expect(parseArgs(["--limit", "5"]).verify).toBe(25); // the unscoped sweep keeps its own bounded verify
  });

  it("the printed reviewed write command keeps --manifest, --limit, --concurrency and --verify 0, and parses", () => {
    const cmd = reviewedWriteCommand(131, 4, "reports/logo-repair/manifest-x.json");
    for (const flag of ["--write", "--trigger backfill", "--limit 131", "--concurrency 4", "--verify 0", "--manifest reports/logo-repair/manifest-x.json"]) expect(cmd).toContain(flag);
    expect(parseArgs(cmd.split(" ").slice(3))).toMatchObject({ write: true, trigger: "backfill", limit: 131, concurrency: 4, verify: 0, manifest: "reports/logo-repair/manifest-x.json" });
    expect(reviewedWriteCommand(0, 2, "m.json")).toContain("--limit 1 "); // never an empty cap
  });
});

describe("dry run makes zero external writes", () => {
  it("resolves and previews without any storage upload or database mutation", async () => {
    const writes: string[] = [];
    const deny = (what: string) => () => {
      writes.push(what);
      throw new Error(`dry run must not call ${what}`);
    };
    const q: any = { select: () => q, eq: () => q, is: () => q, neq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
    const fake: any = {
      storage: { from: () => ({ upload: deny("storage.upload"), remove: deny("storage.remove") }) },
      from: () => ({ ...q, update: deny("update"), insert: deny("insert"), upsert: deny("upsert"), delete: deny("delete") }),
      rpc: deny("rpc"),
    };
    const deps = buildDeps(fake, "https://proj.supabase.co", new Set(), false, null);
    const out = await repairCompanyLogo(
      { id: "22222222-2222-4222-8222-222222222222", name: "Dryco", slug: "dryco", domain: "dry.co", careers_url: null, ats_type: null, logo_url: "https://unavatar.io/dry.co", logo_attempts: 0, claim_token: "dry-run" },
      {
        ...deps,
        resolve: async () => ({ imageUrl: "https://dry.co/icon.png", source: "homepage-icon", domain: "dry.co", buffer: makePng(64, 64, "dry-run-mark"), contentType: "image/png", ext: "png", width: 64, height: 64 }),
        jobsFor: async () => [],
        rejectedHashes: async () => new Set(),
        companiesSharingHash: async () => 0,
      }
    );
    expect(out.status).toBe("repaired"); // the plan only
    expect(writes).toEqual([]);
  });
});
