import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-level guard: no detail/top10/all-active mapper may rewrite every non-internship job_type to "Full-time".
describe("job_type wire mapping", () => {
  for (const f of ["src/app/api/jobs/search/route.ts", "src/lib/jobs/service.ts", "src/app/api/jobs/top10/route.ts", "src/app/api/jobs/recommended/route.ts", "src/lib/api/jobs.ts"]) {
    it(`${f} has no blanket Full-time rewrite`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/job_type === "internship" \? "Internship" : "Full-time"/);
      expect(src).not.toMatch(/job_type \|\| "Full-time"/);
    });
  }
});
