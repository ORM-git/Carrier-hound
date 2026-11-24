import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 21: sentinel-driven next pages on mobile over the existing server pagination.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");
const service = readFileSync("src/lib/jobs/service.ts", "utf8");
const loadMore = page.slice(page.indexOf("const handleLoadMore = async"), page.indexOf("const savedApps = useMemo"));

describe("mobile incremental loading (item 21)", () => {
  it("one request at a time, abortable, stale-guarded, deduped in server order, errors surface", () => {
    expect(loadMore).toContain("if (loadMoreAbortRef.current) return;");
    expect(loadMore).toContain("signal: controller.signal");
    expect(loadMore).toContain("queryKey !== lastQueryKeyRef.current");
    expect(loadMore).toContain("res.jobs.filter((j) => !seen.has(j.id))");
    expect(loadMore).toContain("setLoadMoreError(true)");
    expect(service).toContain("signal: options.signal");
  });

  it("query changes abort the in-flight page and reset the error", () => {
    const reset = page.slice(page.indexOf("lastQueryKeyRef.current = queryKey;"), page.indexOf("getLiveJobs({\n      page: 1,"));
    expect(reset).toContain("loadMoreAbortRef.current?.abort();");
    expect(reset).toContain("setLoadMoreError(false);");
  });

  it("sentinel is mobile-only, pauses on error/loading/end, and the manual button + end state remain", () => {
    expect(loadMore).toContain('window.matchMedia("(max-width: 639px)")');
    expect(loadMore).toContain("!canLoadMore || loadMoreError || loadingJobs");
    expect(page).toContain('data-testid="jobs-load-more-sentinel"');
    expect(page).toContain("[overflow-anchor:none]");
    expect(page).toContain('? "Retry"');
    expect(page).toContain('data-testid="jobs-list-end"');
    expect(loadMore).not.toMatch(/while\s*\(/); // no fetch-all loop
  });
});
