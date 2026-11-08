/**
 * Offline test for src/lib/flags/flags.ts (Backend sheet row 48).
 * Run: npx tsx scripts/test-flags-registry.ts
 * Checks the registry rules match the call sites and that no env flag is unregistered.
 */
import fs from "node:fs";
import path from "node:path";
import { FLAGS, isFlagEnabled, getFlagDefinition } from "../src/lib/flags/flags";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const root = path.join(__dirname, "..");
function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "__tests__") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
}
const files: string[] = [];
walk(path.join(root, "src"), files);
walk(path.join(root, "netlify"), files);

// Flags the code compares to the string "true".
const re = /process\.env\.([A-Z0-9_]+)\s*[!=]==\s*["']true["']/g;
const found = new Set<string>();
const source = new Map<string, string>();
for (const f of files) {
  if (f.endsWith(path.join("lib", "flags", "flags.ts"))) continue; // the registry itself
  const text = fs.readFileSync(f, "utf8");
  source.set(f, text);
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
}

const registered = new Set(FLAGS.map((f) => f.envVar));
const missing = Array.from(found).filter((n) => !registered.has(n));
check("every process.env.X === \"true\" flag in src/ and netlify/ is registered" + (missing.length ? ` (missing: ${missing.join(", ")})` : ""), missing.length === 0);

const allText = Array.from(source.values()).join("\n");
const stale = FLAGS.filter((f) => !allText.includes(f.envVar)).map((f) => f.envVar);
check("every registered flag is still referenced in the code" + (stale.length ? ` (stale: ${stale.join(", ")})` : ""), stale.length === 0);

check("no duplicate env var names", registered.size === FLAGS.length);
check("every default is off (current behavior)", FLAGS.every((f) => f.defaultEnabled === false));
check("every entry has a description", FLAGS.every((f) => f.description.trim().length > 0));
check("billing flag is registered, public, strict and off by default",
  getFlagDefinition("NEXT_PUBLIC_BILLING_ENABLED")?.rule === "strict_true" && isFlagEnabled("NEXT_PUBLIC_BILLING_ENABLED", {}) === false);

// Rules mirror the call sites.
check("strict_true: unset is off", isFlagEnabled("ALLOW_LOCALHOST_CORS", {}) === false);
check("strict_true: exact true is on", isFlagEnabled("ALLOW_LOCALHOST_CORS", { ALLOW_LOCALHOST_CORS: "true" }) === true);
check("strict_true: TRUE, 1, yes, true with spaces are all off",
  ["TRUE", "1", "yes", " true", "true "].every((v) => isFlagEnabled("ALLOW_LOCALHOST_CORS", { ALLOW_LOCALHOST_CORS: v }) === false));
check("strict_true: false and empty are off",
  isFlagEnabled("ALLOW_LOCALHOST_CORS", { ALLOW_LOCALHOST_CORS: "false" }) === false && isFlagEnabled("ALLOW_LOCALHOST_CORS", { ALLOW_LOCALHOST_CORS: "" }) === false);
check("truthy_words: true, 1, yes, on, any case and spaces are on",
  ["true", "1", "yes", "on", " ON ", "Yes"].every((v) => isFlagEnabled("AI_GLOBAL_DISABLE", { AI_GLOBAL_DISABLE: v }) === true));
check("truthy_words: unset, false, 0, no, empty are off",
  [undefined, "false", "0", "no", ""].every((v) => isFlagEnabled("AI_GLOBAL_DISABLE", { AI_GLOBAL_DISABLE: v }) === false));
check("AI_GLOBAL_DISABLE rule matches the handler's own parser",
  /normalized === "true" \|\| normalized === "1" \|\| normalized === "yes" \|\| normalized === "on"/.test(fs.readFileSync(path.join(root, "src/lib/ai/serviceHandler.ts"), "utf8")));
let threw = false;
try { isFlagEnabled("NOT_A_FLAG", {}); } catch { threw = true; }
check("unknown flag name throws instead of reading as off", threw);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
