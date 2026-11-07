/**
 * Row 53 (accessible form errors): a visible error banner is not enough -
 * the field that failed must expose aria-invalid and point at the message
 * via aria-describedby, so screen-reader users land on the input and hear
 * why it failed. Attribute-only contract; rendered output is unchanged.
 * The early-access form was the existing reference implementation.
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

const FORMS: Array<{ file: string; name: string; errorId: string }> = [
  { file: "src/app/login/page.tsx", name: "login", errorId: "login-error-msg" },
  { file: "src/app/signup/page.tsx", name: "signup", errorId: "signup-error-msg" },
  { file: "src/app/early-access/page.tsx", name: "early-access", errorId: "early-access-error-msg" },
];

for (const { file, name, errorId } of FORMS) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  check(src.includes(`id="${errorId}"`), `${name}: error message element carries id="${errorId}"`);
  check(src.includes("role=\"alert\"") || src.includes('role="alert"'), `${name}: error message announces via role="alert"`);
  check(/aria-invalid=\{/.test(src), `${name}: failing input sets aria-invalid from error state`);
  check(src.includes(`aria-describedby={`) && src.includes(errorId), `${name}: failing input wires aria-describedby to ${errorId}`);
}

console.log(`\nform-error-wiring: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
