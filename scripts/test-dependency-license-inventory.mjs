import assert from "node:assert/strict";
import { inventory, isStrongCopyleft, evaluateLicensePolicy } from "./dependency-license-inventory.mjs";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  // Negative control proves that a synthetic runtime copyleft violation fails the policy
  const badFixture = {
    lockfileVersion: 3,
    packages: {
      "": { license: "UNLICENSED" },
      "node_modules/violator": { version: "1.0.0", license: "GPL-3.0", dev: false },
    },
  };
  const report = inventory(badFixture);
  const policy = evaluateLicensePolicy(report);
  if (!policy.passed) {
    console.log("NEGATIVE CONTROL PASS: Deliberate runtime copyleft violation correctly detected as failure.");
    process.exit(0);
  } else {
    console.error("NEGATIVE CONTROL FAIL: Expected runtime copyleft violation to fail policy.");
    process.exit(1);
  }
}

// 1. Base inventory tests
const result = inventory({
  lockfileVersion: 3,
  packages: {
    "": { license: "UNLICENSED" },
    "node_modules/routine": { version: "1.0.0", license: "MIT" },
    "node_modules/compound": { version: "2.0.0", license: "MIT OR GPL-3.0", dev: true },
    "node_modules/missing": { version: "1.0.0" },
    "node_modules/link": { link: true },
  },
});
assert.equal(result.dependencyCount, 3);
assert.equal(result.manualReviewCount, 2);
assert.equal(result.missingMetadataCount, 1);
assert.equal(result.entries.find((entry) => entry.location.endsWith("compound")).scope, "development");
assert.equal(result.entries.find((entry) => entry.license === "MIT").review, "notice-review");
assert.throws(() => inventory({ lockfileVersion: 1 }), /lockfile v3/);

// 2. Strong-copyleft identifier and expression tests
assert.equal(isStrongCopyleft("GPL-2.0"), true);
assert.equal(isStrongCopyleft("GPL-2.0-only"), true);
assert.equal(isStrongCopyleft("GPL-2.0-or-later"), true);
assert.equal(isStrongCopyleft("GPL-3.0"), true);
assert.equal(isStrongCopyleft("GPL-3.0-only"), true);
assert.equal(isStrongCopyleft("GPL-3.0-or-later"), true);
assert.equal(isStrongCopyleft("AGPL-3.0"), true);
assert.equal(isStrongCopyleft("AGPL-1.0"), true);
assert.equal(isStrongCopyleft("SSPL-1.0"), true);
assert.equal(isStrongCopyleft("Commons-Clause"), true);
assert.equal(isStrongCopyleft("Apache-2.0 with Commons-Clause"), true);

// Permissive licenses are NOT copyleft
assert.equal(isStrongCopyleft("MIT"), false);
assert.equal(isStrongCopyleft("Apache-2.0"), false);
assert.equal(isStrongCopyleft("BSD-2-Clause"), false);
assert.equal(isStrongCopyleft("BSD-3-Clause"), false);
assert.equal(isStrongCopyleft("ISC"), false);
assert.equal(isStrongCopyleft("UNKNOWN"), false);

// Dual-licensing (OR): permissive branch allows licensee to avoid copyleft obligations
assert.equal(isStrongCopyleft("MIT OR GPL-3.0-or-later"), false);
assert.equal(isStrongCopyleft("(MIT OR GPL-3.0-or-later)"), false);
assert.equal(isStrongCopyleft("GPL-2.0 OR GPL-3.0"), true); // both copyleft

// Combined licensing (AND): copyleft component binds the overall work
assert.equal(isStrongCopyleft("MIT AND GPL-3.0"), true);

// 3. Fixture 1: Copyleft runtime dep fails
const runtimeCopyleftLock = {
  lockfileVersion: 3,
  packages: {
    "": { license: "UNLICENSED" },
    "node_modules/gpl-runtime": { version: "1.0.0", license: "GPL-3.0", dev: false },
    "node_modules/agpl-runtime": { version: "2.0.0", license: "AGPL-3.0" },
    "node_modules/sspl-runtime": { version: "1.0.0", license: "SSPL-1.0" },
    "node_modules/commons-runtime": { version: "1.0.0", license: "Commons-Clause" },
    "node_modules/gpl2-runtime": { version: "1.0.0", license: "GPL-2.0" },
    "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" },
  },
};
const runtimeReport = inventory(runtimeCopyleftLock);
const runtimePolicy = evaluateLicensePolicy(runtimeReport);
assert.equal(runtimePolicy.passed, false, "Runtime copyleft dependencies must fail policy");
assert.equal(runtimePolicy.runtimeCopyleft.length, 5, "Expected 5 runtime copyleft violations");
assert.equal(runtimePolicy.devCopyleft.length, 0);

// 4. Fixture 2: Dev-only copyleft warns (does not fail check)
const devCopyleftLock = {
  lockfileVersion: 3,
  packages: {
    "": { license: "UNLICENSED" },
    "node_modules/gpl-dev-tool": { version: "1.0.0", license: "GPL-3.0", dev: true },
    "node_modules/agpl-dev-tool": { version: "2.0.0", license: "AGPL-3.0", dev: true },
    "node_modules/mit-runtime": { version: "1.0.0", license: "MIT", dev: false },
  },
};
const devReport = inventory(devCopyleftLock);
const devPolicy = evaluateLicensePolicy(devReport);
assert.equal(devPolicy.passed, true, "Dev-only copyleft must not fail policy");
assert.equal(devPolicy.runtimeCopyleft.length, 0, "No runtime copyleft violations");
assert.equal(devPolicy.devCopyleft.length, 2, "Dev copyleft dependencies must be recorded for warning");

// 5. Fixture 3: MIT / Apache / Permissive passes
const permissiveLock = {
  lockfileVersion: 3,
  packages: {
    "": { license: "UNLICENSED" },
    "node_modules/pkg-mit": { version: "1.0.0", license: "MIT" },
    "node_modules/pkg-apache": { version: "2.0.0", license: "Apache-2.0" },
    "node_modules/pkg-bsd": { version: "1.0.0", license: "BSD-3-Clause" },
    "node_modules/pkg-dual": { version: "1.0.0", license: "MIT OR GPL-3.0-or-later" },
  },
};
const permissiveReport = inventory(permissiveLock);
const permissivePolicy = evaluateLicensePolicy(permissiveReport);
assert.equal(permissivePolicy.passed, true, "Permissive dependencies must pass policy");
assert.equal(permissivePolicy.runtimeCopyleft.length, 0);
assert.equal(permissivePolicy.devCopyleft.length, 0);
assert.equal(permissivePolicy.unknownLicenses.length, 0);

// 6. Fixture 4: UNKNOWN licenses are captured for warning
const unknownLock = {
  lockfileVersion: 3,
  packages: {
    "": { license: "UNLICENSED" },
    "node_modules/mystery-dep": { version: "1.0.0" }, // missing license property -> UNKNOWN
    "node_modules/explicit-unknown": { version: "1.0.0", license: "UNKNOWN" },
  },
};
const unknownReport = inventory(unknownLock);
const unknownPolicy = evaluateLicensePolicy(unknownReport);
assert.equal(unknownPolicy.passed, true, "UNKNOWN licenses warn, they do not fail the copyleft check");
assert.equal(unknownPolicy.unknownLicenses.length, 2, "Expected 2 UNKNOWN licenses in warning list");

console.log("All license inventory and policy tests PASSED (copyleft runtime fails, dev copyleft warns, MIT/Apache passes).");
