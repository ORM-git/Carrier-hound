import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const DOC_PATH = path.join(ROOT, "docs", "audit-sweeps", "be-sweep-1.md");

const EXPECTED_ROWS = [
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

if (process.argv.includes("--negative-control")) {
  console.error("Negative control triggered intentionally");
  process.exit(1);
}

function verifyNegativeControl(): void {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(ROOT, "scripts", "test-be-sweep-1.ts"),
      "--negative-control",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.notEqual(
    res.status,
    0,
    "Negative control invocation must exit non-zero",
  );
}

function extractSections(markdown: string): Map<string, string> {
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

  const sections = new Map<string, string>();
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : markdown.length;
    assert.equal(
      cur.indexNum,
      i + 1,
      `Expected section ${i + 1}, got section ${cur.indexNum} (${cur.title})`,
    );
    assert.equal(
      sections.has(cur.title),
      false,
      `Duplicate section title found: ${cur.title}`,
    );
    sections.set(cur.title, markdown.slice(cur.bodyStart, nextStart));
  }

  return sections;
}

function collectCitedRepoPaths(markdown: string): string[] {
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
      (prefix) => token === prefix || token.startsWith(prefix),
    );
    if (!matchesPrefix) continue;
    const normalized = token.replace(/\/+$/, "");
    paths.add(normalized);
  }

  return [...paths];
}

function run(): void {
  verifyNegativeControl();

  assert.equal(
    fs.existsSync(DOC_PATH),
    true,
    "docs/audit-sweeps/be-sweep-1.md must exist",
  );

  const markdown = fs.readFileSync(DOC_PATH, "utf8");
  const sections = extractSections(markdown);

  assert.equal(
    sections.size,
    EXPECTED_ROWS.length,
    `Expected ${EXPECTED_ROWS.length} numbered sections, found ${sections.size}`,
  );

  for (const rowTitle of EXPECTED_ROWS) {
    assert.equal(
      sections.has(rowTitle),
      true,
      `Missing audit sweep section for "${rowTitle}"`,
    );
  }

  assert.equal(
    /^##\s+.*\bserverless limits\b/im.test(markdown),
    false,
    "serverless limits must NOT have a verdict section in be-sweep-1.md",
  );

  let closeCount = 0;
  let gapCount = 0;

  for (const rowTitle of EXPECTED_ROWS) {
    const body = sections.get(rowTitle)!;
    const verdictMatch = body.match(/-\s+\*\*Verdict\*\*:\s+`(CLOSE|GAP)`/);
    assert.ok(
      verdictMatch,
      `Section "${rowTitle}" must declare "- **Verdict**: \`CLOSE\`" or "\`GAP\`"`,
    );
    const verdict = verdictMatch[1];

    const classMatch = body.match(/-\s+\*\*Classification\*\*:\s+`([^`]+)`/);
    assert.ok(
      classMatch,
      `Section "${rowTitle}" must declare "- **Classification**: \`...\`"`,
    );

    if (verdict === "CLOSE") {
      closeCount += 1;
    } else {
      gapCount += 1;
      assert.ok(
        ["Code", "Owner step", "Code + Owner step"].includes(classMatch[1]),
        `GAP section "${rowTitle}" classification must be Code, Owner step, or Code + Owner step (got "${classMatch[1]}")`,
      );
      assert.match(
        body,
        /-\s+\*\*Remaining Gap\*\*:/,
        `GAP section "${rowTitle}" must document "**Remaining Gap**"`,
      );
    }

    assert.match(
      body,
      /-\s+\*\*Evidence on `main`\*\*:/,
      `Section "${rowTitle}" must document "**Evidence on \`main\`**"`,
    );
  }

  assert.match(
    markdown,
    new RegExp(`\\*\\*${closeCount} \`CLOSE\`\\*\\*\\s*·\\s*\\*\\*${gapCount} \`GAP\`\\*\\*`),
    `Summary header counts must match section totals (${closeCount} CLOSE, ${gapCount} GAP)`,
  );

  const citedPaths = collectCitedRepoPaths(markdown);
  assert.ok(citedPaths.length >= 40, "Expected at least 40 verified repo path citations");
  for (const relPath of citedPaths) {
    const absPath = path.join(ROOT, relPath);
    assert.equal(
      fs.existsSync(absPath),
      true,
      `Cited repository path does not exist on disk: ${relPath}`,
    );
  }

  console.log(
    `[test-be-sweep-1] PASS: ${EXPECTED_ROWS.length} sections verified (${closeCount} CLOSE, ${gapCount} GAP), ${citedPaths.length} cited paths exist, negative control verified.`,
  );
}

run();
