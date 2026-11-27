/**
 * Fixture tests for the static internal route-resolution audit.
 * Run with: npx tsx scripts/test-internal-route-audit.ts
 * Builds a temporary app tree; no network, accounts or real config.
 */
import assert from "assert";
import { spawnSync, type SpawnSyncReturns } from "child_process";
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
write("src/app/shadowed/page.tsx");
write("src/app/(marketing)/pricing/page.tsx");
write("src/app/blog/[slug]/page.tsx");
write("src/app/docs/[...path]/page.tsx");
write("src/app/shop/[[...rest]]/page.tsx");
write("src/app/feed.xml/route.ts", "export const GET = () => new Response('');\n");
write("src/app/@modal/secret/page.tsx");
write("src/app/_private/page.tsx");
write("public/logo.png", "");
write("netlify/functions/hello.ts", "export default () => null;\n");

const toml = (from: string, to: string, status: number, extra = "") =>
  `[[redirects]]\n  from = "${from}"\n  to = "${to}"\n  status = ${status}\n${extra}`;
write(
  "netlify.toml",
  [
    toml("/t-chain", "/t-chain2", 301),
    toml("/t-chain2", "/about", 302),
    toml("/t-splat/*", "/docs/:splat", 301),
    toml("/t-missing", "/does-not-exist", 301),
    toml("/t-loop", "/t-loop", 301),
    toml("/t-error", "/error.html", 500),
    toml("/t-cond", "/about", 302, '  conditions = {Country = ["us"]}\n'),
    toml("/t-cond-table", "/about", 302, '  [redirects.conditions]\n    Role = ["admin"]\n'),
    toml("/t-ext", "https://example.com/", 301),
    toml("/shadowed", "/does-not-exist", 301, "  force = true\n"),
    toml("/t-fn", "/.netlify/functions/hello", 200),
    toml("/t-fn-missing", "/.netlify/functions/nope", 200),
    toml("/t-html", "/about.html", 200),
    toml("/*", "/404.html", 404),
  ].join("\n"),
);
write(
  "public/_redirects",
  [
    "# comment line",
    "/r-chain /r-chain2 301",
    "/r-chain2 /about 301",
    "/r-splat/* /docs/:splat 301!",
    "/p/:id /blog/:id 301!",
    "/r-missing /nowhere 301",
    "/r-loop-a /r-loop-b 301",
    "/r-loop-b /r-loop-a 301",
    "/r-error /about 500",
    "/r-cond /about 302 Country=us",
    "/r-query id=:id /blog/:id 301",
    "/r-mid/*/x /about 301",
    "/r-param /blog/:missing 301",
  ].join("\n") + "\n",
);
write("next.config.mjs", "export default { async redirects() { return []; } };\n");

// Each case is one TSX expression, written as `const xN = <expr>;` on line N.
const cases: [string, LinkStatus][] = [
  ['<a href="/about" />', "page"],
  ['<a href="/" />', "page"],
  ['<a href="/pricing" />', "page"], // route group stripped
  ['<a href="/marketing/pricing" />', "invalid"], // group name is not a URL segment
  ['<a href={"/blog/hello"} />', "page"], // dynamic segment
  ['<a href="/blog" />', "invalid"], // dynamic segment requires a value
  ['<a href="/blog/a/b" />', "invalid"],
  ["<a href={`/docs/a/b/c`} />", "page"], // catch-all
  ['<a href="/docs" />', "invalid"], // catch-all needs >= 1 segment
  ['<a href="/shop" />', "page"], // optional catch-all, zero segments
  ['<a href="/shop/x/y" />', "page"],
  ['<a href="/about?tab=1#team" />', "page"], // query/hash stripped
  ['<a href="/about/" />', "page"], // trailing slash
  ["router.push(`/about?q=${q}`)", "page"], // interpolation only in query
  ['<a href="/feed.xml" />', "page"], // route handler
  ['<img href="/logo.png" />', "asset"],
  ['<a href="/secret" />', "invalid"], // parallel slot is not a URL segment
  ['<a href="/_private" />', "invalid"], // private folder
  ['<a href="https://example.com/about" />', "external"],
  ['<a href="//cdn.example.com/x" />', "external"],
  ['<a href="mailto:hi@example.com" />', "external"],
  ['<a href="tel:+100" />', "external"],
  ['<a href="#top" />', "external"],
  ['router.replace("/missing-page")', "invalid"],
  ['[{ href: "/nowhere" }]', "invalid"], // object nav config form
  ['<a href={"/ab\\u006fut"} />', "page"], // escaped literal decodes to /about
  ["<a href={`/blog/${slug}`} />", "dynamic"],
  ["<a href={target} />", "dynamic"],
  ["router.push(next)", "dynamic"],
  // netlify.toml rules
  ['<a href="/t-chain" />', "alias"], // two-hop chain ending at a page
  ['<a href="/t-splat/a/b" />', "alias"], // splat substituted into catch-all page
  ['<a href="/t-missing" />', "invalid"], // destination does not exist
  ['<a href="/t-loop" />', "invalid"], // self loop
  ['<a href="/t-error" />', "invalid"], // 500 is not a redirect
  ['<a href="/t-cond" />', "unresolved"], // inline conditions
  ['<a href="/t-cond-table" />', "unresolved"], // [redirects.conditions] table
  ['<a href="/t-ext" />', "external"], // off-site destination, unverified
  ['<a href="/shadowed" />', "invalid"], // forced rule shadows the page and points nowhere
  ['<a href="/t-fn" />', "alias"], // rewrite to an existing netlify function
  ['<a href="/t-fn-missing" />', "invalid"],
  ['<a href="/t-html" />', "alias"], // rewrite to the static-export html of a page
  ['<a href="/anything-else" />', "invalid"], // only the /* 404 fallback matches
  // public/_redirects rules
  ['<a href="/r-chain" />', "alias"],
  ['<a href="/r-splat/x" />', "alias"],
  ['<a href="/p/42" />', "alias"], // placeholder substituted into dynamic page
  ['<a href="/r-missing" />', "invalid"],
  ['<a href="/r-loop-a" />', "invalid"], // two-rule loop
  ['<a href="/r-error" />', "invalid"],
  ['<a href="/r-cond" />', "unresolved"], // Country condition
  ['<a href="/r-query" />', "unresolved"], // query-parameter condition
  ['<a href="/r-mid/a/x" />', "unresolved"], // mid-path splat not modelled
  ['<a href="/r-param" />', "unresolved"], // destination parameter not captured
];
write("src/components/Nav.tsx", cases.map(([expr], i) => `const x${i + 1} = ${expr};`).join("\n") + "\n");

// Multiline forms: each target is reported on the line where its expression starts.
const multiline = [
  "export const A = () => (", //               1
  "  <Link", //                                2
  "    href={", //                             3
  '      "/multiline-missing"', //             4  invalid
  "    }", //                                  5
  "  />", //                                   6
  ");", //                                     7
  "router.push(", //                           8
  '  "/multiline-push-missing"', //            9  invalid
  ");", //                                     10
  "const B = <a", //                           11
  '  href="/about"', //                        12 page
  "/>;", //                                    13
  "const C = <Link href={", //                 14
  '  cond ? "/a" : "/b"', //                   15 dynamic
  "} />;", //                                  16
  "const D = <Link href={`/blog/${", //        17 dynamic (path interpolation)
  "  slug", //                                 18
  "}`} />;", //                                19
  "router.replace(", //                        20
  "  `/docs/${", //                            21 dynamic
  "    part}`", //                             22
  ");", //                                     23
  '// href="/commented-out" is not a link', // 24 ignored
].join("\n");
write("src/components/Multi.tsx", multiline + "\n");
write("src/components/__tests__/Nav.test.tsx", 'const t = <a href="/only-in-a-test" />;\n');

// The fixture CLI takes ~2-3s locally; 45s per run leaves CI headroom while two runs still
// fit inside suite-runner's default 120s per-suite timeout.
const CLI_TIMEOUT_MS = 45_000;
const HANG_CONTROL_TIMEOUT_MS = 1_000;

/** Runs a child directly (no shell, so the kill reaches it) with a finite deadline. */
function runChild(args: string[], timeoutMs = CLI_TIMEOUT_MS, command = process.execPath): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
}

/** Fails with diagnostics unless the child started and exited on its own (no spawn error, no signal). */
function assertExited(run: SpawnSyncReturns<string>, label: string): void {
  if (run.error || run.signal !== null || run.status === null) {
    const err = run.error as NodeJS.ErrnoException | undefined;
    throw new Error(
      `${label} did not exit normally: error=${err ? `${err.code ?? ""} ${err.message}` : "none"}, ` +
        `signal=${run.signal}, status=${run.status}\n--- stdout ---\n${run.stdout ?? ""}\n--- stderr ---\n${run.stderr ?? ""}`,
    );
  }
}

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

try {
  const result = runAudit(root);
  const nav = result.findings.filter((f) => f.file === "src/components/Nav.tsx");
  const multi = result.findings.filter((f) => f.file === "src/components/Multi.tsx");

  check("one finding per fixture line, with file:line evidence", () => {
    assert.deepStrictEqual(nav.map((f) => f.line), cases.map((_, i) => i + 1));
  });
  cases.forEach(([expr, expected], i) => {
    check(`${expected.padEnd(10)} ${expr}`, () =>
      assert.strictEqual(nav[i]?.status, expected, `got ${nav[i]?.status} (${nav[i]?.reason})`),
    );
  });
  check("multiline forms: statuses and start lines", () => {
    assert.deepStrictEqual(
      multi.map((f) => [f.line, f.status, f.status === "dynamic" ? "" : f.raw]),
      [
        [4, "invalid", "/multiline-missing"],
        [9, "invalid", "/multiline-push-missing"],
        [12, "page", "/about"],
        [15, "dynamic", ""],
        [17, "dynamic", ""],
        [21, "dynamic", ""],
      ],
    );
  });
  check("chain reasons name each hop", () => {
    const chain = nav.find((f) => f.raw === "/t-chain");
    assert.match(chain?.reason ?? "", /\/t-chain -> \/t-chain2 301.*\/t-chain2 -> \/about 302/);
    assert.match(nav.find((f) => f.raw === "/r-loop-a")?.reason ?? "", /redirect loop/);
  });
  check("test/fixture files are not production findings", () => {
    assert.strictEqual(result.findings.some((f) => f.raw === "/only-in-a-test"), false);
    assert.strictEqual(result.skippedTestFiles, 1);
  });
  check("conditional/unmodelled rules and next.config reported as boundaries", () => {
    const b = result.boundaries.join("\n");
    assert.match(b, /\/t-cond -> \/about not modelled/);
    assert.match(b, /\/r-mid\/\*\/x -> \/about not modelled \(mid-path splat\)/);
    assert.match(b, /next\.config\.mjs declares redirects/);
  });

  const cli = (fixture: string) =>
    runChild(["--import", "tsx", path.join(__dirname, "check-internal-links.ts"), "--root", fixture]);

  check("hang control: a stalled child is killed and reported, not left running", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-audit-hang-"));
    try {
      const hang = path.join(dir, "hang.cjs");
      fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
      const started = Date.now();
      const run = runChild([hang], HANG_CONTROL_TIMEOUT_MS);
      assert.ok(Date.now() - started < 15_000, `hang control took ${Date.now() - started}ms`);
      assert.throws(() => assertExited(run, "hang control"), /hang control did not exit normally.*ETIMEDOUT/s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  check("launch control: a child that cannot start is reported, not read as an exit code", () => {
    const run = runChild([], HANG_CONTROL_TIMEOUT_MS, path.join(os.tmpdir(), "route-audit-missing-binary-does-not-exist"));
    assert.throws(() => assertExited(run, "launch control"), /launch control did not exit normally.*ENOENT/s);
  });

  check("negative control: CLI exits 1 on invalid links and names file:line", () => {
    const run = cli(root);
    assertExited(run, "fixture CLI (invalid links)");
    assert.strictEqual(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /src\/components\/Nav\.tsx:24 -> \/missing-page/);
    assert.match(run.stdout, /src\/components\/Multi\.tsx:4 -> \/multiline-missing/);
  });
  check("positive control: CLI exits 0 once invalid links are gone, and says what it did not verify", () => {
    write(
      "src/components/Nav.tsx",
      cases.filter(([, s]) => s !== "invalid").map(([expr], i) => `const y${i} = ${expr};`).join("\n") + "\n",
    );
    fs.rmSync(path.join(root, "src/components/Multi.tsx"));
    const run = cli(root);
    assertExited(run, "fixture CLI (clean)");
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /no network requests/);
    assert.match(run.stdout, /No confirmed invalid internal links\. \d+ dynamic, \d+ unresolved and \d+ external targets were not verified/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll route-audit fixture tests passed." : `\n${failures} route-audit fixture test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
