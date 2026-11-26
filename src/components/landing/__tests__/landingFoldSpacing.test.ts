import { readFileSync } from "fs";
import { expect, it } from "vitest";

/**
 * Guard for the owner-requested compact phone fold spacing (2026-11-26, PR #822).
 * The overrides live in their own stylesheet, loaded in app/page.tsx after both
 * vendored ssampe-parity stylesheets, so those files stay byte-pure and their
 * parity guard is untouched. This test pins the exact override values, the
 * phone-only media wrapper and the import order, then proves that weakened or
 * widened copies are rejected (negative controls).
 */

const FILE = "src/styles/careermonke-landing-fold.css";
const PAGE = "src/app/page.tsx";

const EXPECTED =
  "@media (max-width:640px){" +
  ".cm-top .fold{min-height:0;}" +
  ".cm-top .hero{flex:none;}" +
  ".cm-top .nav{height:48px;}" +
  ".cm-top .hero-inner{flex:none;justify-content:flex-start;padding:16px 0 20px;}" +
  ".cm-top .kicker{margin-top:8px;}" +
  ".cm-top h1{margin-top:6px;}" +
  ".cm-top .subhead{margin-top:10px;}" +
  ".cm-top .cta{margin-top:-40px;padding:0 16px 8px;}" +
  ".landing-wrapper section.stats-row{padding-top:14px;}" +
  "}";

const strip = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

function checkFold(css: string, page: string): void {
  expect(strip(css)).toBe(EXPECTED);
  expect(css).not.toMatch(/@keyframes|!important|@import|@font-face/);
  expect(css).not.toMatch(/(^|[{}\s])(:root|html|body)\s*[{,]/);
  const foldAt = page.indexOf('import "@/styles/careermonke-landing-fold.css";');
  expect(foldAt).toBeGreaterThan(-1);
  expect(foldAt).toBeGreaterThan(page.indexOf('import "@/styles/careermonke-landing-lower.css";'));
}

it("pins the exact phone-fold spacing overrides, phone-only and scoped", () => {
  checkFold(readFileSync(FILE, "utf8"), readFileSync(PAGE, "utf8"));
});

it("rejects weakened or widened copies (negative controls)", () => {
  const css = readFileSync(FILE, "utf8");
  const page = readFileSync(PAGE, "utf8");
  const cases: [string, string, string][] = [
    ["CTA tuck reduced", css.replace("margin-top: -40px", "margin-top: -24px"), page],
    ["media widened to tablets", css.replace("max-width: 640px", "max-width: 768px"), page],
    ["stats gap loosened", css.replace("padding-top: 14px", "padding-top: 24px"), page],
    ["extra unscoped rule", css + "\nh1 { color: red; }\n", page],
    ["import missing", css, page.replace('import "@/styles/careermonke-landing-fold.css";\n', "")],
    [
      "loaded before lower css",
      css,
      page.replace(
        'import "@/styles/careermonke-landing-lower.css";\nimport "@/styles/careermonke-landing-fold.css";',
        'import "@/styles/careermonke-landing-fold.css";\nimport "@/styles/careermonke-landing-lower.css";'
      ),
    ],
  ];
  for (const [name, c, p] of cases) {
    expect(c === css && p === page, `${name}: negative control did not apply`).toBe(false);
    expect(() => checkFold(c, p), name).toThrow();
  }
});
