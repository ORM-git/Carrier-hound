/**
 * Row 32 (focus management): pins the route-change focus contract.
 * Programmatic focus to the main landmark after client-side navigation,
 * logic only: skip initial load, tabindex=-1 on the landmark (out of tab
 * order), preventScroll (no scroll jump), renders nothing.
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

const comp = fs.readFileSync(path.join(ROOT, "src/components/a11y/RouteFocusManager.tsx"), "utf8");
check(comp.includes('"use client"') || comp.includes("'use client'"), "RouteFocusManager is a client component");
check(comp.includes("usePathname"), "reacts to pathname changes");
check(/isInitialLoad\.current\s*=\s*false/.test(comp), "skips the initial page load");
check(comp.includes('setAttribute("tabindex", "-1")'), "landmark gets tabindex=-1 (script-focusable, not in tab order)");
check(comp.includes("preventScroll: true"), "focus uses preventScroll (no scroll jump)");
check(/return null;/.test(comp), "renders no DOM");
{
  const code = comp.replace(/\/\*\*[\s\S]*?\*\//g, "");
  check(!/className=/.test(code), "no class/style additions to page markup (logic only)");
  check(code.includes('style.outlineStyle = "none"'), "programmatic focus suppresses the default outline inline (zero-visual)");
}

const layout = fs.readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8");
check(layout.includes("RouteFocusManager"), "mounted in the root layout");

console.log(`\nroute-focus: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
