/**
 * Fixture tests for the static internal route-resolution audit.
 * Run with: npx tsx scripts/test-internal-route-audit.ts
 * Builds a temporary app tree; no network, accounts or real config.
 */
import assert from "assert";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runAudit, type LinkStatus } from "./lib/internal-route-audit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-audit-"));
const write = (file: string, body = "export default function P() { return null; }\n") => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

write("src/app/page.tsx");
write("src/app/about/page.tsx");
write("src/app/(marketing)/pricing/page.tsx");
write("src/app/blog/[slug]/page.tsx");
write("src/app/docs/[...path]/page.tsx");
write("src/app/shop/[[...rest]]/page.tsx");
write("src/app/feed.xml/route.ts", "export const GET = () => new Response('');\n");
write("src/app/@modal/secret/page.tsx");
write("src/app/_private/page.tsx");
write("public/logo.png", "");
write(
  "netlify.toml",
  [
    '[[redirects]]\n  from = "/old-about"\n  to = "/about"\n  status = 301',
    '[[redirects]]\n  from = "/legacy/*"\n  to = "/"\n  status = 301',
    '[[redirects]]\n  from = "/*"\n  to = "/404.html"\n  status = 404',
  ].join("\n\n"),
);
write("public/_redirects", "/p/:id /blog/:id 301!\n/* /404.html 404\n");
write("next.config.mjs", "export default { async redirects() { return []; } };\n");

const cases: [string, LinkStatus][] = [
  ['<a href="/about">', "page"],
  ['<a href="/">', "page"],
  ['<Link href="/pricing">', "page"], // route group stripped
  ['<Link href="/marketing/pricing">', "invalid"], // group name is not a URL segment
  ['<Link href={"/blog/hello"}>', "page"], // dynamic segment
  ['<Link href="/blog">', "invalid"], // dynamic segment requires a value
  ['<Link href="/blog/a/b">', "invalid"],
  ["<Link href={`/docs/a/b/c`}>", "page"], // catch-all
  ['<Link href="/docs">', "invalid"], // catch-all needs >= 1 segment
  ['<Link href="/shop">', "page"], // optional catch-all, zero segments
  ['<Link href="/shop/x/y">', "page"],
  ['<a href="/about?tab=1#team">', "page"], // query/hash stripped
  ['<a href="/about/">', "page"], // trailing slash
  ["router.push(`/about?q=${q}`)", "page"], // interpolation only in query
  ['<a href="/feed.xml">', "page"], // route handler
  ['<img href="/logo.png">', "asset"],
  ['<a href="/old-about">', "alias"], // netlify.toml static alias
  ['<a href="/legacy/anything/here">', "alias"], // splat alias
  ['<a href="/p/42">', "alias"], // _redirects placeholder alias
  ['<a href="/secret">', "invalid"], // parallel slot is not a URL segment
  ['<a href="/_private">', "invalid"], // private folder
  ['<a href="https://example.com/about">', "external"],
  ['<a href="//cdn.example.com/x">', "external"],
  ['<a href="mailto:hi@example.com">', "external"],
  ['<a href="tel:+100">', "external"],
  ['<a href="#top">', "external"],
  ['router.replace("/missing-page")', "invalid"],
  ['const NAV = [{ href: "/nowhere" }]', "invalid"], // object nav config form
  ["<Link href={`/blog/${slug}`}>", "dynamic"],
  ["<Link href={target}>", "dynamic"],
  ["router.push(next)", "dynamic"],
];
write("src/components/Nav.tsx", cases.map(([line]) => line).join("\n") + "\n");
write("src/components/__tests__/Nav.test.tsx", '<a href="/only-in-a-test">\n');

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n  ${(err as Error).message}`);
  }
};

const result = runAudit(root);
const nav = result.findings.filter((f) => f.file === "src/components/Nav.tsx");

check("one finding per fixture line, with file:line evidence", () => {
  assert.deepStrictEqual(nav.map((f) => f.line), cases.map((_, i) => i + 1));
});
cases.forEach(([line, expected], i) => {
  check(`${expected.padEnd(8)} ${line}`, () => assert.strictEqual(nav[i]?.status, expected, `got ${nav[i]?.status}`));
});
check("test/fixture files are not production findings", () => {
  assert.strictEqual(result.findings.some((f) => f.raw === "/only-in-a-test"), false);
  assert.strictEqual(result.skippedTestFiles, 1);
});
check("404 fallback rules are not aliases", () => {
  assert.strictEqual(result.aliases.some((a) => a.pattern === "/*"), false);
});
check("next.config redirects reported as a boundary, not executed", () => {
  assert.ok(result.boundaries.some((b) => b.includes("next.config.mjs")), result.boundaries.join("; "));
});

const cli = (fixture: string) =>
  spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "check-internal-links.ts"), "--root", fixture], {
    encoding: "utf8",
  });

check("negative control: CLI exits 1 on invalid links and names file:line", () => {
  const run = cli(root);
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /src\/components\/Nav\.tsx:27 -> \/missing-page/);
});
check("positive control: CLI exits 0 once invalid links are gone", () => {
  write("src/components/Nav.tsx", cases.filter(([, s]) => s !== "invalid").map(([l]) => l).join("\n") + "\n");
  const run = cli(root);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /no network requests/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll route-audit fixture tests passed." : `\n${failures} route-audit fixture test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
