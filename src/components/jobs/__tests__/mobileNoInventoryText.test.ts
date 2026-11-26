import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 22: no remaining/total inventory text at the bottom of the mobile list; counters and pagination stay.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");

describe("mobile bottom inventory text (item 22)", () => {
  it("normal loading has no button or remaining count at any width", () => {
    expect(page).toContain("{(isPhone ? !loadingMore : (loadMoreError || autoLoadPaused)) && (");
    expect(page).not.toContain("remaining)`");
    expect(page).not.toContain("`Load More Verified Positions (~");
  });

  it("tab counters and pagination state are untouched", () => {
    expect(page).toContain("count: savedCount,");
    expect(page).toContain("count: appliedCount,");
    expect(page).toContain("const canLoadMore = activeTab === \"recommended\" && hasNextPage;");
  });
});
