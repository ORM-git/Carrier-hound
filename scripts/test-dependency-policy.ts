/**
 * Rank 38 (Dependency Hell) - dependency-resolution policy guard.
 *
 * PR #250's package/lockfile patches are on main (lockfile: next 14.2.35,
 * dompurify 3.4.17, undici 6.29.1, ws 8.22.1, zod 4.6.7; package.json
 * overrides dompurify/undici/ws/zod). What remains owner-side: raising the
 * next floor in package.json and the Next major upgrade (current advisories
 * for the next 14 line are only fixed in 15.5.x/16.x - owner decision).
 *
 * This suite locks in the reviewed-good resolution state so no future PR
 * silently regresses it:
 *   1. package.json and package-lock.json root specs stay in sync (drift guard)
 *   2. resolved next stays >= 14.2.35 everywhere in the lockfile (the
 *      PR #250-reviewed baseline; downgrade = fail)
 *   3. every override floor is satisfied by every resolved copy of that
 *      package, root and nested (override integrity)
 *   4. every override stays load-bearing (resolves at least one copy; a
 *      no-op override means it should be removed, with this test updated)
 *
 * All floors are read from package.json / the lockfile at runtime - no
 * hardcoded versions except the PR #250 next baseline cited in the audit
 * sheet evidence. Offline: no npm audit, no network.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const NEXT_REVIEWED_BASELINE = "14.2.35"; // PR #250-reviewed lockfile state (sheet evidence)

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
  }
}

interface Semver { major: number; minor: number; patch: number; }
function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
function gte(version: string, floor: string): boolean {
  const v = parseSemver(version);
  const f = parseSemver(floor);
  if (!v || !f) return false;
  return cmp(v, f) >= 0;
}
function specFloor(spec: string): string | null {
  // "^3.4.17" / "~3.4.17" / ">=3.4.17" / "3.4.17" -> "3.4.17"
  const m = /(\d+\.\d+\.\d+)/.exec(spec);
  return m ? m[1] : null;
}

interface LockPackage { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }
interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockPackage & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
}

function main(): void {
  const pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  const lockRaw = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const lock = JSON.parse(lockRaw) as Lockfile;

  check(typeof lock.lockfileVersion === "number" && Object.keys(lock.packages).length > 0,
    "package-lock.json parses with a non-empty packages map");

  const lockRoot = lock.packages[""] as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  check(!!lockRoot, "lockfile has a root package entry");

  // --- 1. drift guard: every root spec matches between package.json and lockfile ---
  const pkgDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const lockDeps = { ...(lockRoot?.dependencies ?? {}), ...(lockRoot?.devDependencies ?? {}) };
  const drifted = Object.entries(pkgDeps).filter(([name, spec]) => lockDeps[name] !== spec);
  check(drifted.length === 0,
    `root dependency specs identical in package.json and package-lock.json${drifted.length ? ` (drifted: ${drifted.map(([n]) => n).join(", ")})` : ""}`);

  // --- 2. next baseline ---
  check(typeof pkgDeps.next === "string", "next is a declared dependency");
  const nextCopies = Object.entries(lock.packages)
    .filter(([k]) => /(^|\/)node_modules\/next$/.test(k))
    .map(([k, v]) => ({ path: k, version: v.version ?? "?" }));
  check(nextCopies.length > 0, "lockfile resolves at least one next copy");
  const belowBaseline = nextCopies.filter((c) => !gte(c.version, NEXT_REVIEWED_BASELINE));
  check(belowBaseline.length === 0,
    `every resolved next copy is >= ${NEXT_REVIEWED_BASELINE} (PR #250-reviewed baseline)${belowBaseline.length ? ` (below: ${belowBaseline.map((c) => `${c.version} at ${c.path}`).join(", ")})` : ""}`);

  // --- 3/4. override integrity + load-bearing ---
  const overrides = pkg.overrides ?? {};
  const expectedKeys = ["dompurify", "undici", "ws", "zod"]; // current reviewed set on main
  for (const key of expectedKeys) {
    check(typeof overrides[key] === "string",
      `override for ${key} present (reviewed baseline set; remove only with a lockfile regen proving it stale)`);
  }
  for (const [name, spec] of Object.entries(overrides)) {
    const floor = specFloor(spec);
    check(!!floor, `override ${name}@${spec} has a parseable semver floor`);
    if (!floor) continue;
    const copies = Object.entries(lock.packages)
      .filter(([k]) => new RegExp(`(^|/)node_modules/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(k))
      .map(([k, v]) => ({ path: k, version: v.version ?? "?" }));
    check(copies.length > 0,
      `override ${name} is load-bearing (resolves ${copies.length} copy/copies in the lockfile)`);
    const violating = copies.filter((c) => !gte(c.version, floor));
    check(violating.length === 0,
      `every resolved ${name} copy satisfies override floor ${floor}${violating.length ? ` (violating: ${violating.map((c) => `${c.version} at ${c.path}`).join(", ")})` : ""}`);
  }

  // --- suite registration ---
  const sr = fs.readFileSync(path.join(ROOT, "scripts", "suite-runner.ts"), "utf8");
  check(sr.includes("test-dependency-policy.ts"), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} dependency-policy checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main();
