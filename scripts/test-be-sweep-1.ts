import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const DOC_PATH = path.join(ROOT, "docs", "audit-sweeps", "be-sweep-1.md");

export const EXPECTED_ROWS = [
  "Dead letter queues",
  "Webhook delivery log & replay",
  "Cron failure visibility",
  "API gateways",
  "Retries",
  "Exponential backoff",
  "Event-driven architecture",
  "Saga pattern",
  "Pessimistic locking",
  "Distributed locks",
  "Backpressure",
  "Mass assignment",
  "Third-party script risk",
  "Session revocation",
  "Zero-downtime migrations",
  "Change management",
  "Big-O hot-path",
  "Twelve-factor",
  "Log level discipline",
  "Prompt/response logging",
  "Common crawl usage",
] as const;

export interface TableRowSummary {
  indexNum: number;
  title: string;
  verdict: "CLOSE" | "GAP";
  classification: string;
  summary: string;
}

export interface DetailSectionSummary {
  indexNum: number;
  title: string;
  verdict: "CLOSE" | "GAP";
  classification: string;
  body: string;
}

export function parseOverviewTable(markdown: string): TableRowSummary[] {
  const tableBlockMatch = markdown.match(/##\s+Owner Sign-Off Block[\s\S]*?\n(\|[\s\S]*?\n)(?:\n---|\n##)/);
  assert.ok(tableBlockMatch, "Markdown must include '## Owner Sign-Off Block' table");

  const lines = tableBlockMatch[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  // Expect at least header, separator, and 21 rows
  assert.ok(lines.length >= 23, `Expected at least 23 table lines (header + sep + 21 rows), got ${lines.length}`);

  const rows: TableRowSummary[] = [];
  for (let i = 2; i < lines.length; i++) {
    const cols = lines[i]
      .split("|")
      .map((c) => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

    if (cols.length < 5) continue;
    const indexNum = Number(cols[0]);
    const title = cols[1];
    const rawVerdict = cols[2].replace(/`/g, "").trim();
    assert.ok(
      rawVerdict === "CLOSE" || rawVerdict === "GAP",
      `Overview table row ${indexNum} invalid verdict: "${rawVerdict}"`
    );
    const verdict = rawVerdict as "CLOSE" | "GAP";
    const classification = cols[3].replace(/`/g, "").trim();
    const summary = cols[4];

    rows.push({
      indexNum,
      title,
      verdict,
      classification,
      summary,
    });
  }

  return rows;
}

export function extractSections(markdown: string): Map<string, DetailSectionSummary> {
  const headingRegex = /^##\s+(\d+)\.\s+(.+)$/gm;
  const matches: Array<{ indexNum: number; title: string; start: number; bodyStart: number }> = [];

  for (const m of markdown.matchAll(headingRegex)) {
    const start = m.index ?? 0;
    const bodyStart = start + m[0].length;
    matches.push({
      indexNum: Number(m[1]),
      title: m[2].trim(),
      start,
      bodyStart,
    });
  }

  const sections = new Map<string, DetailSectionSummary>();
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : markdown.length;
    assert.equal(
      cur.indexNum,
      i + 1,
      `Expected section ${i + 1}, got section ${cur.indexNum} (${cur.title})`
    );
    assert.equal(
      sections.has(cur.title.toLowerCase()),
      false,
      `Duplicate section title found: ${cur.title}`
    );

    const body = markdown.slice(cur.bodyStart, nextStart);
    const verdictMatch = body.match(/-\s+\*\*Verdict\*\*:\s+`(CLOSE|GAP)`/);
    assert.ok(
      verdictMatch,
      `Section "${cur.title}" must declare "- **Verdict**: \`CLOSE\`" or "\`GAP\`"`
    );
    const verdict = verdictMatch[1] as "CLOSE" | "GAP";

    const classMatch = body.match(/-\s+\*\*Classification\*\*:\s+`([^`]+)`/);
    assert.ok(
      classMatch,
      `Section "${cur.title}" must declare "- **Classification**: \`...\`"`
    );
    const classification = classMatch[1].trim();

    sections.set(cur.title.toLowerCase(), {
      indexNum: cur.indexNum,
      title: cur.title,
      verdict,
      classification,
      body,
    });
  }

  return sections;
}

export function collectCitedRepoPaths(markdown: string): string[] {
  const codeSpanRegex = /`([^`\n]+)`/g;
  const pathPrefixes = [
    "src/",
    "scripts/",
    "docs/",
    "supabase/",
    "netlify/",
    ".github/",
    "public/",
    "SOURCES.md",
    "netlify.toml",
    "sentry.server.config.ts",
  ];
  const paths = new Set<string>();

  for (const m of markdown.matchAll(codeSpanRegex)) {
    const token = m[1].trim();
    if (token.includes(" ") || token.includes("*")) continue;
    const matchesPrefix = pathPrefixes.some(
      (prefix) => token === prefix || token.startsWith(prefix)
    );
    if (!matchesPrefix) continue;
    const normalized = token.replace(/\/+$/, "");
    paths.add(normalized);
  }

  return [...paths];
}

export function validateAuditDocument(
  markdown: string,
  options: { checkFilesOnDisk?: boolean } = { checkFilesOnDisk: true }
): { closeCount: number; gapCount: number; citedPaths: string[] } {
  assert.equal(
    /^##\s+.*\bserverless limits\b/im.test(markdown),
    false,
    "serverless limits must NOT have a verdict section in be-sweep-1.md"
  );

  const overviewRows = parseOverviewTable(markdown);
  const sections = extractSections(markdown);

  assert.equal(
    overviewRows.length,
    EXPECTED_ROWS.length,
    `Overview table must have ${EXPECTED_ROWS.length} rows, found ${overviewRows.length}`
  );
  assert.equal(
    sections.size,
    EXPECTED_ROWS.length,
    `Expected ${EXPECTED_ROWS.length} numbered sections, found ${sections.size}`
  );

  let closeCount = 0;
  let gapCount = 0;

  for (let idx = 0; idx < EXPECTED_ROWS.length; idx++) {
    const expectedTitle = EXPECTED_ROWS[idx];
    const tableRow = overviewRows[idx];
    assert.equal(
      tableRow.indexNum,
      idx + 1,
      `Overview row ${idx + 1} has mismatched index ${tableRow.indexNum}`
    );
    assert.equal(
      tableRow.title.toLowerCase(),
      expectedTitle.toLowerCase(),
      `Overview row ${idx + 1} expected title "${expectedTitle}", got "${tableRow.title}"`
    );

    const section = sections.get(expectedTitle.toLowerCase());
    assert.ok(section, `Missing section for "${expectedTitle}"`);

    // Strict Agreement Check between Overview Table and Detail Section
    assert.equal(
      tableRow.verdict,
      section.verdict,
      `Overview row ${idx + 1} verdict "${tableRow.verdict}" disagrees with section verdict "${section.verdict}" for "${expectedTitle}"`
    );
    assert.equal(
      tableRow.classification,
      section.classification,
      `Overview row ${idx + 1} classification "${tableRow.classification}" disagrees with section classification "${section.classification}" for "${expectedTitle}"`
    );

    if (section.verdict === "CLOSE") {
      closeCount += 1;
      assert.equal(
        section.classification,
        "—",
        `CLOSE section "${expectedTitle}" classification must be "—" (got "${section.classification}")`
      );
    } else {
      gapCount += 1;
      assert.ok(
        ["Code", "Owner step", "Code + Owner step"].includes(section.classification),
        `GAP section "${expectedTitle}" classification must be Code, Owner step, or Code + Owner step (got "${section.classification}")`
      );
      assert.match(
        section.body,
        /-\s+\*\*Remaining Gap\*\*:/,
        `GAP section "${expectedTitle}" must document "**Remaining Gap**"`
      );
    }

    assert.match(
      section.body,
      /-\s+\*\*Evidence on `main`\*\*:/,
      `Section "${expectedTitle}" must document "**Evidence on \`main\`**"`
    );
  }

  assert.match(
    markdown,
    new RegExp(`\\*\\*${closeCount} \`CLOSE\`\\*\\*\\s*·\\s*\\*\\*${gapCount} \`GAP\`\\*\\*`),
    `Summary header counts must match section totals (${closeCount} CLOSE, ${gapCount} GAP)`
  );

  const citedPaths = collectCitedRepoPaths(markdown);
  assert.ok(citedPaths.length >= 40, "Expected at least 40 verified repo path citations");

  if (options.checkFilesOnDisk) {
    for (const relPath of citedPaths) {
      const absPath = path.join(ROOT, relPath);
      assert.equal(
        fs.existsSync(absPath),
        true,
        `Cited repository path does not exist on disk: ${relPath}`
      );
    }
  }

  return { closeCount, gapCount, citedPaths };
}

function runRealMutationRejections(): void {
  const original = fs.readFileSync(DOC_PATH, "utf8");

  // Mutation 1: Overview table and detail section disagree on verdict
  const mutatedVerdict = original.replace(
    /## 1\. Dead letter queues\s*\n\s*-\s+\*\*Verdict\*\*:\s+`GAP`/,
    "## 1. Dead letter queues\n\n- **Verdict**: `CLOSE`"
  );
  assert.throws(
    () => validateAuditDocument(mutatedVerdict, { checkFilesOnDisk: false }),
    /disagrees with section verdict/,
    "Guard must reject disagreement between overview table verdict and detail section verdict"
  );

  // Mutation 2: Overview table and detail section disagree on classification
  const mutatedClass = original.replace(
    /## 3\. Cron failure visibility\s*\n\s*-\s+\*\*Verdict\*\*:\s+`GAP`\s*\n\s*-\s+\*\*Classification\*\*:\s+`Code \+ Owner step`/,
    "## 3. Cron failure visibility\n\n- **Verdict**: `GAP`\n- **Classification**: `Code`"
  );
  assert.throws(
    () => validateAuditDocument(mutatedClass, { checkFilesOnDisk: false }),
    /disagrees with section classification/,
    "Guard must reject disagreement between overview table classification and detail section classification"
  );

  // Mutation 3: Missing section
  const mutatedMissingSection = original.replace(/## 21\. Common crawl usage[\s\S]*$/, "");
  assert.throws(
    () => validateAuditDocument(mutatedMissingSection, { checkFilesOnDisk: false }),
    /Expected 21 numbered sections/,
    "Guard must reject missing audit section"
  );

  // Mutation 4: Non-existent cited repo path
  const mutatedFakePath = original.replace(
    /`src\/lib\/events\/failedEvents\.ts`/,
    "`src/lib/events/non_existent_fake_file.ts`"
  );
  assert.throws(
    () => validateAuditDocument(mutatedFakePath, { checkFilesOnDisk: true }),
    /Cited repository path does not exist on disk/,
    "Guard must reject non-existent cited file paths"
  );

  // Mutation 5: Forbidden serverless limits section included
  const mutatedServerless = original + "\n\n## 22. Serverless limits\n\n- **Verdict**: `CLOSE`\n";
  assert.throws(
    () => validateAuditDocument(mutatedServerless, { checkFilesOnDisk: false }),
    /serverless limits must NOT have a verdict section/,
    "Guard must reject inclusion of serverless limits"
  );
}

function verifyNegativeControl(): void {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(ROOT, "scripts", "test-be-sweep-1.ts"),
      "--negative-control",
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(
    res.status,
    0,
    "Negative control invocation must exit non-zero"
  );
  assert.match(
    res.stderr,
    /disagrees with section verdict|NEGATIVE_CONTROL_MUTATION_REJECTED/,
    `Expected negative control stderr to show mutated-doc rejection, got:\n${res.stderr}`
  );
}

function run(): void {
  if (process.argv.includes("--negative-control")) {
    console.log("[NEGATIVE CONTROL MODE] Testing mutated-doc rejection in child process...");
    runRealMutationRejections();
    // Intentionally induce a real mutated-doc validation failure so child exits non-zero with assertion message
    const raw = fs.readFileSync(DOC_PATH, "utf8");
    const mutated = raw.replace(
      /## 1\. Dead letter queues\s*\n\s*-\s+\*\*Verdict\*\*:\s+`GAP`/,
      "## 1. Dead letter queues\n\n- **Verdict**: `CLOSE`"
    );
    console.error("NEGATIVE_CONTROL_MUTATION_REJECTED: Inducing deliberate mutated document failure");
    validateAuditDocument(mutated, { checkFilesOnDisk: false });
    return;
  }

  assert.equal(
    fs.existsSync(DOC_PATH),
    true,
    "docs/audit-sweeps/be-sweep-1.md must exist"
  );

  // 1. Verify that mutated documents are rejected by the validator
  runRealMutationRejections();

  // 2. Verify negative control subprocess exits non-zero on real mutated-doc assertion failure
  verifyNegativeControl();

  // 3. Verify real on-disk document
  const markdown = fs.readFileSync(DOC_PATH, "utf8");
  const { closeCount, gapCount, citedPaths } = validateAuditDocument(markdown, { checkFilesOnDisk: true });

  console.log(
    `[test-be-sweep-1] PASS: 21 overview table rows and detail sections agree (${closeCount} CLOSE, ${gapCount} GAP), ${citedPaths.length} cited paths exist on disk, mutated-doc rejections and negative control subprocess verified.`
  );
}

run();
