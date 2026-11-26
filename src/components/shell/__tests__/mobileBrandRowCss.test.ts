import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// The Jobs mobile stylesheet once hid [data-testid="app-mobile-brand"] (the old in-bar brand link). The shared brand row
// reuses that test id, so no rule may hide, collapse or move the brand or the row, or the wordmark disappears on Jobs.
describe("jobs mobile-reference.css does not hide the shared brand row", () => {
  const css = readFileSync("src/app/jobs/mobile-reference.css", "utf8");
  const BAD = /display:\s*none|visibility:\s*hidden|opacity:\s*0|position:\s*absolute|(^|[\s;{])order:/;
  const rules = css.split("}").map((r) => r.trim()).filter(Boolean);
  const hit = (needle: string) => rules.filter((r) => r.includes(needle));
  it("no display:none / visibility / opacity rule targets the brand link or the row, except the detail view", () => {
    for (const needle of ['data-testid="app-mobile-brand"', 'data-testid="app-mobile-brand-row"', 'data-testid="app-mobile-profile-link"']) {
      for (const rule of hit(needle)) {
        if (rule.includes("cm-mobile-detail")) continue;
        expect(rule, rule).not.toMatch(BAD);
      }
    }
  });
  it("the row is only hidden together with the bar, in the mobile detail", () => {
    const detail = hit('data-testid="app-mobile-brand-row"').filter((r) => r.includes("display: none"));
    expect(detail).toHaveLength(1);
    expect(detail[0]).toContain("cm-mobile-detail");
  });
  it("negative control: the old rule that hid the brand would be caught", () => {
    expect('.cm-jobs-reference.cm-mobile-list [data-testid="app-mobile-brand"] { display: none; ').toMatch(BAD);
  });
});
