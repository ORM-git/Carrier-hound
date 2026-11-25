import { readFileSync } from "fs";
import { expect, it } from "vitest";
it("bounds phone ticker cards and preserves desktop motion and actual image sources", () => {
  const css = readFileSync("src/styles/careermonke-landing-lower.css", "utf8");
  const phone = css.slice(css.indexOf("/* Phone ticker:"));
  expect(phone).toContain("@media (max-width:639px)");
  expect(phone).toContain(".ls-track{animation:none");
  expect(phone).toContain("width:290px;max-width:calc(100vw - 48px)");
  expect(phone).toContain("background:#fff");
  expect(phone).toContain("overflow:hidden;text-overflow:ellipsis");
  expect(css.slice(0, css.indexOf("/* Phone ticker:"))).toContain("animation:cml-lsMarquee 60s linear infinite");
});
