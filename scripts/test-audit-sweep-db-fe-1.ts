/**
 * scripts/test-audit-sweep-db-fe-1.ts
 *
 * Offline guard test for Audit Sweep #1 (docs/audit-sweeps/db-fe-sweep-1.md).
 * Verifies:
 *   1. docs/audit-sweeps/db-fe-sweep-1.md exists.
 *   2. Every one of the 22 specified rows (19 DB + 3 FE) has its own section.
 *   3. Every section states an explicit CLOSE or GAP verdict and gap classification
 *      (None for CLOSE; Code / Owner step / Code + Owner step for GAP).
 *   4. Summary table counts match the actual per-section verdicts.
 *   5. Every backticked repo file path cited in the document exists on disk.
 *   6. Self-test negative controls fail on a missing row or nonexistent cited file.
 *
 * Run: npx tsx scripts/test-audit-sweep-db-fe-1.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const DOC_REL = "docs/audit-sweeps/db-fe-sweep-1.md";

export const EXPECTED_ROWS: ReadonlyArray<{ number: number; title: string; domain: "Database" | "Frontend" }> = [
  { number: 1, title: "RPO/RTO targets", domain: "Database" },
  { number: 2, title: "Change-history triggers", domain: "Database" },
  { number: 3, title: "Unused index audit", domain: "Database" },
  { number: 4, title: "Index bloat monitoring", domain: "Database" },
  { number: 5, title: "Table size monitoring", domain: "Database" },
  { number: 6, title: "Index usage monitoring", domain: "Database" },
  { number: 7, title: "Dead tuple watch", domain: "Database" },
  { number: 8, title: "Purge jobs for log tables", domain: "Database" },
  { number: 9, title: "Views / materialized views", domain: "Database" },
  { number: 10, title: "Connection pooling", domain: "Database" },
  { number: 11, title: "PITR", domain: "Database" },
  { number: 12, title: "Concurrent refresh", domain: "Database" },
  { number: 13, title: "CREATE INDEX CONCURRENTLY", domain: "Database" },
  { number: 14, title: "Alert on failed cron", domain: "Database" },
  { number: 15, title: "Zero-downtime migration discipline", domain: "Database" },
  { number: 16, title: "DB health check", domain: "Database" },
  { number: 17, title: "Normalization", domain: "Database" },
  { number: 18, title: "N+1 avoidance", domain: "Database" },
  { number: 19, title: "DB-level RBAC", domain: "Database" },
  { number: 20, title: "SWR caching rows", domain: "Frontend" },
  { number: 21, title: "Concurrent features", domain: "Frontend" },
  { number: 22, title: "PWA manifest", domain: "Frontend" },
];

const CITED_PATH_RE =
  /`((?:docs|src|scripts|supabase|\.github\/workflows|public)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g;

export interface ParsedSection {
  number: number;
  title: string;
  domain: string;
  verdict: "CLOSE" | "GAP";
  gapClass: string;
}

export function validateAuditSweepDoc(markdown: string, repoRoot: string = ROOT): ParsedSection[] {
  const sectionMatches = [...markdown.matchAll(/^###\s+(\d+)\.\s+(.+)$/gm)];
  assert.strictEqual(
    sectionMatches.length,
    EXPECTED_ROWS.length,
    `Expected ${EXPECTED_ROWS.length} row sections, found ${sectionMatches.length}`
  );

  const parsed: ParsedSection[] = [];
  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    const start = match.index ?? 0;
    const end = i + 1 < sectionMatches.length ? (sectionMatches[i + 1].index ?? markdown.length) : markdown.length;
    const body = markdown.slice(start, end);

    const num = Number(match[1]);
    const title = match[2].trim();
    const expected = EXPECTED_ROWS[i];
    assert.strictEqual(num, expected.number, `Section #${i + 1} expected number ${expected.number}, got ${num}`);
    assert.strictEqual(title, expected.title, `Section #${num} expected title '${expected.title}', got '${title}'`);

    const domainMatch = body.match(/^- \*\*Domain:\*\*\s*(Database|Frontend)\s*$/m);
    assert.ok(domainMatch, `Section '${title}' missing valid **Domain:** field`);
    assert.strictEqual(domainMatch[1], expected.domain, `Section '${title}' domain mismatch`);

    const verdictMatch = body.match(/^- \*\*Verdict:\*\*\s*`(CLOSE|GAP)`\s*$/m);
    assert.ok(verdictMatch, `Section '${title}' missing **Verdict:** \`CLOSE\` or \`GAP\``);
    const verdict = verdictMatch[1] as "CLOSE" | "GAP";

    const gapMatch = body.match(/^- \*\*Gap Classification:\*\*\s*(None|Code|Owner step|Code \+ Owner step)\s*$/m);
    assert.ok(gapMatch, `Section '${title}' missing valid **Gap Classification:** field`);
    const gapClass = gapMatch[1];

    if (verdict === "CLOSE") {
      assert.strictEqual(gapClass, "None", `Section '${title}' has CLOSE verdict so Gap Classification must be None`);
    } else {
      assert.notStrictEqual(gapClass, "None", `Section '${title}' has GAP verdict so Gap Classification cannot be None`);
    }

    assert.ok(body.includes("**Artifacts Verified on `main`:**"), `Section '${title}' missing Artifacts Verified section`);
    assert.ok(body.includes("**What Is Missing / Owner Sign-Off Action:**"), `Section '${title}' missing Owner Sign-Off Action section`);

    parsed.push({ number: num, title, domain: domainMatch[1], verdict, gapClass });
  }

  // Verify summary counts match parsed sections
  const closeCount = parsed.filter((s) => s.verdict === "CLOSE").length;
  const gapCount = parsed.filter((s) => s.verdict === "GAP").length;
  const ownerOnlyCount = parsed.filter((s) => s.verdict === "GAP" && s.gapClass === "Owner step").length;
  const codeOnlyCount = parsed.filter((s) => s.verdict === "GAP" && s.gapClass === "Code").length;
  const bothCount = parsed.filter((s) => s.verdict === "GAP" && s.gapClass === "Code + Owner step").length;

  const summaryChecks: Array<[string, number]> = [
    ["Total rows audited", parsed.length],
    ["`CLOSE`", closeCount],
    ["`GAP`", gapCount],
    ["`GAP` — Owner step only", ownerOnlyCount],
    ["`GAP` — Code only", codeOnlyCount],
    ["`GAP` — Code + Owner step", bothCount],
  ];

  for (const [label, expectedVal] of summaryChecks) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rowRe = new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*(\\d+)\\s*\\|$`, "m");
    const m = markdown.match(rowRe);
    assert.ok(m, `Summary table missing row '${label}'`);
    assert.strictEqual(
      Number(m[1]),
      expectedVal,
      `Summary table count mismatch for '${label}': expected ${expectedVal}, got ${m[1]}`
    );
  }

  // Verify every cited repo file path exists on disk
  const citedPaths = new Set<string>();
  CITED_PATH_RE.lastIndex = 0;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = CITED_PATH_RE.exec(markdown)) !== null) {
    citedPaths.add(pathMatch[1]);
  }
  assert.ok(citedPaths.size >= 40, `Expected at least 40 cited repo paths, found ${citedPaths.size}`);
  for (const relPath of citedPaths) {
    const absPath = path.resolve(repoRoot, relPath);
    assert.ok(fs.existsSync(absPath), `Cited file does not exist on disk: ${relPath}`);
  }

  return parsed;
}

function runNegativeControls(validMarkdown: string) {
  // 1. Missing row triggers failure
  const dropped = validMarkdown.replace(/^###\s+22\.\s+PWA manifest[\s\S]*$/m, "");
  assert.throws(
    () => validateAuditSweepDoc(dropped),
    /Expected 22 row sections/,
    "Negative control failed: missing section should throw"
  );

  // 2. Nonexistent cited file path triggers failure
  const phantomPath = validMarkdown.replace(
    "`public/manifest.webmanifest`",
    "`public/nonexistent-phantom-manifest.webmanifest`"
  );
  assert.throws(
    () => validateAuditSweepDoc(phantomPath),
    /Cited file does not exist on disk/,
    "Negative control failed: phantom cited file should throw"
  );
}

function main() {
  if (process.argv.includes("--negative-control")) {
    console.error("Deliberate negative control exit requested.");
    process.exit(1);
  }

  const absDoc = path.resolve(ROOT, DOC_REL);
  assert.ok(fs.existsSync(absDoc), `Missing audit sweep doc at ${DOC_REL}`);
  const markdown = fs.readFileSync(absDoc, "utf8");

  const parsed = validateAuditSweepDoc(markdown, ROOT);
  runNegativeControls(markdown);

  const runner = fs.readFileSync(path.resolve(ROOT, "scripts/suite-runner.ts"), "utf8");
  assert.ok(
    runner.includes("scripts/test-audit-sweep-db-fe-1.ts"),
    "scripts/suite-runner.ts must register scripts/test-audit-sweep-db-fe-1.ts"
  );

  const closeCount = parsed.filter((s) => s.verdict === "CLOSE").length;
  const gapCount = parsed.filter((s) => s.verdict === "GAP").length;
  console.log(`PASS: ${DOC_REL} verified (${parsed.length} rows: ${closeCount} CLOSE, ${gapCount} GAP)`);
  console.log("PASS: Summary counts, gap classifications, cited file paths, and negative controls verified");
}

main();
