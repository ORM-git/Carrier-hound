import { readFileSync } from "fs";
import { expect, it } from "vitest";
it("bounds phone ticker cards and preserves desktop motion and actual image sources", () => {
  const css = readFileSync("src/styles/mobile-ticker.css", "utf8");
  const base = readFileSync("src/styles/careermonke-landing-lower.css", "utf8");
  const phone = css.slice(css.indexOf("/* Phone ticker:"));
  expect(phone).toContain("@media (max-width:639px)");
  expect(phone).toContain(".ls-track{animation:cml-lsMarquee 150s linear infinite");
  expect(phone).toContain("@media (max-width:639px) and (prefers-reduced-motion:reduce)");
  expect(phone.slice(0, phone.indexOf("prefers-reduced-motion"))).not.toContain("animation:none");
  expect(phone).toContain("width:290px;max-width:calc(100vw - 48px)");
  expect(phone).toContain("background:#fff");
  expect(phone).toContain("overflow:hidden;text-overflow:ellipsis");
  expect(base).toContain("animation:cml-lsMarquee 60s linear infinite");
});

it("keeps the exception page-ordered, phone-only and ticker-scoped",()=>{
 const css=readFileSync("src/styles/mobile-ticker.css","utf8");
 const component=readFileSync("src/app/page.tsx","utf8");
 expect(component.indexOf('import "@/styles/mobile-ticker.css"')).toBeGreaterThan(component.indexOf('import "@/styles/careermonke-landing-lower.css"'));
 expect(css.match(/@media/g)).toHaveLength(2);
 let depth=0;
 for(const line of css.split("\n")){if(line.trim().startsWith(".landing-wrapper")){expect(depth).toBe(1);expect(line.trim()).toMatch(/^\.landing-wrapper \.ls(?:[- .{:])/);}depth+=(line.match(/\{/g)||[]).length-(line.match(/\}/g)||[]).length;}
 expect(depth).toBe(0);
 expect(css).not.toMatch(/@keyframes|!important/);
});
