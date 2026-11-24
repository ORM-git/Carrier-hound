import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { workModelLabel } from "../workModel";

// CM mobile item 20 follow-up: the work-model label follows remoteScope; hybrid is never shown as On-site.
describe("workModelLabel", () => {
  it.each([
    [{ remote: false, remoteScope: "hybrid" }, "Hybrid"],
    [{ remote: true, remoteScope: "hybrid" }, "Hybrid"],
    [{ remote: false, location: "London (Hybrid)" }, "Hybrid"],
    [{ remote: false, remoteScope: "onsite" }, "On-site"],
    [{ remote: true, remoteScope: "worldwide" }, "Remote"],
    [{ remote: false, remoteScope: "remote" }, "Remote"],
    [{ remote: true, remoteScope: "us-only" }, "Remote"],
    [{ remote: false, remoteScope: "any" }, "Flexible"],
    [{ remote: false }, "On-site"],
    [{ remote: true }, "Remote"],
  ] as const)("%j -> %s", (job, label) => {
    expect(workModelLabel(job)).toBe(label);
  });

  it("the mobile card and the detail metadata use it", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    const mobileCard = page.slice(page.indexOf("MOBILE VIEW (under sm"), page.indexOf("{/* Load More"));
    expect(mobileCard).toContain("{workModelLabel(job)}");
    expect(mobileCard).not.toContain('{job.remote ? "Remote" : "On-site"}');
    expect(detail).toContain("{workModelLabel(job)}");
    expect(detail).not.toContain('{job.remote ? "Remote" : "On-site"}');
  });
});
