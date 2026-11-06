import assert from "node:assert/strict";
import { inventory } from "./dependency-license-inventory.mjs";
const result = inventory({ lockfileVersion: 3, packages: {
  "": { license: "UNLICENSED" },
  "node_modules/routine": { version: "1.0.0", license: "MIT" },
  "node_modules/compound": { version: "2.0.0", license: "MIT OR GPL-3.0", dev: true },
  "node_modules/missing": { version: "1.0.0" },
  "node_modules/link": { link: true },
} });
assert.equal(result.dependencyCount, 3);
assert.equal(result.manualReviewCount, 2);
assert.equal(result.missingMetadataCount, 1);
assert.equal(result.entries.find((entry) => entry.location.endsWith("compound")).scope, "development");
assert.equal(result.entries.find((entry) => entry.license === "MIT").review, "notice-review");
assert.throws(() => inventory({ lockfileVersion: 1 }), /lockfile v3/);
console.log("License inventory fixtures passed: root/link exclusions, missing metadata, compound manual review, dev scope.");
