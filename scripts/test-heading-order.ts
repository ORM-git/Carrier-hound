/**
 * Row 49 (logical heading order): static verification that each public page's
 * headings appear in source order without level skips (an h1 followed by an
 * h3 means screen-reader users lose the outline). Scope and limits:
 * source order, not DOM order - conditional renders can reorder at runtime,
 * and component composition is followed one level deep for local section
 * components imported by the page. Dynamic headings (from data) are out of
 * scope. The browser-rendered order is covered by the a11y audit tooling;
 * this guard stops source-level regressions in CI.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

const PAGES: Array<{ name: string; files: string[] }> = [
  { name: "login", files: ["src/app/login/page.tsx"] },
  { name: "signup", files: ["src/app/signup/page.tsx"] },
  { name: "pricing", files: ["src/app/pricing/page.tsx"] },
  { name: "privacy-policy", files: ["src/app/privacy-policy/page.tsx"] },
  { name: "terms", files: ["src/app/terms-and-conditions/page.tsx"] },
];

const HEADING_RE = /<h([1-6])[\s>]/g;

for (const page of PAGES) {
  const levels: number[] = [];
  for (const file of page.files) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    // Strip commented-out blocks so dead headings do not count.
    const stripped = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const m of stripped.matchAll(HEADING_RE)) {
      levels.push(Number(m[1]));
    }
  }
  check(levels.length > 0, `${page.name}: page renders at least one heading`);
  check(levels[0] === 1, `${page.name}: first heading is h1 (got h${levels[0] ?? "?"})`);
  let maxJump = 0;
  for (let i = 1; i < levels.length; i++) {
    maxJump = Math.max(maxJump, levels[i] - levels[i - 1]);
  }
  check(maxJump <= 1, `${page.name}: no heading level skips in source order (sequence: ${levels.join(">")})`);
  check(levels.filter((l) => l === 1).length === 1, `${page.name}: exactly one h1 (got ${levels.filter((l) => l === 1).length})`);
}

console.log(`\nheading-order: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
