// Row 69 local prep: the search WHERE-clause block, moved verbatim out of the route so the SAME code builds the live query and the
// capture filter AST (recorder). No behavior change in the route.
import { applyExperienceLevelQuery } from "@/lib/jobs/experienceLevels";
import { getCountryFilterClause } from "@/lib/countries";
import { jobTypeOrClause, workModelOrClause } from "@/lib/jobs/jobFilters";
import { applyFeedConstraints, datePostedCutoff } from "@/lib/preferences/feedConstraints";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";
import { applyRequiredYears } from "@/lib/preferences/advancedFilters";

export function sanitizeSearchQuery(input: string): string {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Base visibility of every search/list query (source policy + live rows). Shared by the route and the capture recorder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyBaseVisibility(query: any): any {
  return query.or(VISIBLE_SOURCE_FILTER).eq("is_active", true).eq("status", "active");
}

export interface SearchFilterCtx {
  category: string; remoteOnly: boolean; countryCodeParam: string; locationParam: string; jobTypeParam: string;
  levelParam: string; experienceParam: string; workModelParam: string; dateParam: string;
  feedConstraints: any; requiredYears: any; companyParam: string; salaryMinParam: string; sourceTypeParam: string;
  hasServiceKey: boolean; cleanQuery: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applySearchFilters(query: any, ctx: SearchFilterCtx): any {
  const { category, remoteOnly, countryCodeParam, locationParam, jobTypeParam, levelParam, experienceParam, workModelParam, dateParam, feedConstraints, requiredYears, companyParam, salaryMinParam, sourceTypeParam, hasServiceKey, cleanQuery } = ctx;
      // Category filter matching getLiveJobs logic
      if (category && category !== "all") {
        const c = sanitizeSearchQuery(category).toLowerCase().trim();
        if (c === "trending") {
          query = query.in("category", ["ai", "engineering", "devops"]);
        } else if (c === "tech") {
          query = query.in("category", ["engineering", "devops", "ai", "software"]);
        } else if (c === "ai" || c === "ai-ml" || c === "ai-machine-learning" || c === "machine-learning") {
          query = query.or("category.eq.ai,category.eq.ai-ml,title.ilike.%machine learning%,title.ilike.%deep learning%,title.ilike.%llm%,title.ilike.%nlp%,title.imatch.\\yAI\\y,title.ilike.ai %,title.ilike.% ai %,title.ilike.% ai,title.ilike.ai");
        } else if (c === "data" || c === "data-analytics" || c === "data-science") {
        query = query.or("category.eq.data,category.eq.data-analytics,title.ilike.%data %,title.ilike.%analytics%,title.ilike.%database%");
      } else if (c === "engineering" || c === "software") {
        query = query.in("category", ["engineering", "software"]);
      } else if (c === "internships") {
        query = query.or("job_type.eq.internship,title.ilike.%internship%,title.ilike.%internships%,title.ilike.% intern %,title.ilike.intern %,title.ilike.% intern,title.ilike.%-intern%,title.ilike.%(intern)%,title.ilike.%co-op%,title.ilike.%coop%");
      } else if (c === "remote") {
        query = query.eq("remote", true);
      } else if (c === "fresher") {
        query = query.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%,title.ilike.%internship%,title.ilike.% intern %,job_type.eq.internship");
      } else if (c === "operations") {
        query = query.or("category.eq.operations,title.ilike.%operation%,title.ilike.%ops%");
      } else if (c === "cyber-security") {
        query = query.or("category.eq.cyber-security,title.ilike.%security%,title.ilike.%cyber%");
      } else if (c === "customer-support") {
        query = query.or("category.eq.customer-support,title.ilike.%support%,title.ilike.%customer%,title.ilike.%success%");
      } else if (c === "legal") {
        query = query.or("category.eq.legal,title.ilike.%legal%,title.ilike.%compliance%");
      } else if (c === "healthcare") {
        query = query.or("category.eq.healthcare,title.ilike.%health%,title.ilike.%clinical%");
      } else {
        query = query.or(`category.ilike.%${c}%,title.ilike.%${c}%`);
      }
    }

    if (remoteOnly) {
      query = query.eq("remote", true);
    }

    if (countryCodeParam && countryCodeParam.trim() && countryCodeParam.toLowerCase() !== "all") {
      const code = sanitizeSearchQuery(countryCodeParam).toUpperCase().trim();
      if (code) {
        const orClause = getCountryFilterClause(code);
        if (orClause) {
          query = query.or(orClause);
        } else {
          query = query.eq("country_code", code);
        }
      }
    }

    if (locationParam && locationParam.trim() && locationParam.toLowerCase() !== "all") {
      const loc = sanitizeSearchQuery(locationParam);
      if (loc.toLowerCase() === "remote") {
        query = query.or("remote.eq.true,location.ilike.%remote%");
      } else if (loc) {
        query = query.ilike("location", "%" + loc + "%");
      }
    }

    const jobTypeClause = jobTypeOrClause(jobTypeParam);
    if (jobTypeClause) query = query.or(jobTypeClause);

    if (levelParam && levelParam.trim() && levelParam.toLowerCase() !== "all") {
      query = applyExperienceLevelQuery(query, levelParam);
    }

    if (experienceParam && experienceParam.trim() && experienceParam.toLowerCase() !== "all" && experienceParam.toLowerCase() !== "all experience") {
      const exp = experienceParam.trim().toLowerCase();
      if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) {
        query = query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
      } else if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) {
        query = query
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%")
          .not("title", "ilike", "%junior%")
          .not("title", "ilike", "%entry%");
      } else if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
        query = query
          .or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%")
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%");
      } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      }
    }

    const workModelClause = workModelOrClause(workModelParam);
    if (workModelClause) query = query.or(workModelClause);

    // 24h / 3d / 7d / 30d. A NULL posted_at (unknown source date) never passes an active window.
    const postedCutoff = datePostedCutoff(dateParam);
    if (postedCutoff) query = query.gte("posted_at", postedCutoff);

    query = applyFeedConstraints(query, feedConstraints);
    query = applyRequiredYears(query, requiredYears);

    // Company filter (server-side)
    if (companyParam && companyParam.trim() && companyParam.toLowerCase() !== "all") {
      if (hasServiceKey) {
        const cleanComp = sanitizeSearchQuery(companyParam).trim();
        if (cleanComp) {
          query = query.or(`company.ilike.%${cleanComp}%,company_slug.ilike.%${cleanComp.toLowerCase()}%`);
        }
      }
    }

    // Salary Min filter (only where salary exists)
    if (salaryMinParam) {
      if (hasServiceKey) {
        const minVal = parseInt(salaryMinParam, 10);
        if (!isNaN(minVal) && minVal > 0) {
          query = query.not("salary_min", "is", null).gte("salary_min", minVal);
        }
      }
    }

    // Source Type filter (ats, direct, aggregator, etc.)
    if (sourceTypeParam && sourceTypeParam.trim() && sourceTypeParam.toLowerCase() !== "all") {
      if (hasServiceKey) {
        const st = sanitizeSearchQuery(sourceTypeParam).toLowerCase().trim();
        if (st === "ats") {
          query = query.or("source_type.eq.ats,source.ilike.%board%,source.ilike.%greenhouse%,source.ilike.%lever%,source.ilike.%ashby%");
        } else if (st === "direct") {
          query = query.or("source_type.eq.direct,source_type.eq.ats");
        } else if (st === "aggregator") {
          query = query.or("source_type.eq.aggregator,source_type.eq.feed,source_type.eq.api");
        } else if (st) {
          query = query.or(`source_type.eq.${st},source.ilike.%${st}%`);
        }
      }
    }


    // Search query matching: company and description guarded when jobs_public is used
    if (cleanQuery) {
      const parts = cleanQuery.split(" ").filter((p) => p.length >= 2);
      if (hasServiceKey) {
        if (parts.length > 1) {
          for (const p of parts) {
            query = query.or(
              `title.ilike.%${p}%,company.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%,description.ilike.%${p}%`
            );
          }
        } else {
          query = query.or(
            `title.ilike.%${cleanQuery}%,company.ilike.%${cleanQuery}%,location.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%,description.ilike.%${cleanQuery}%`
          );
        }
      } else {
        // jobs_public lacks company and description columns
        if (parts.length > 1) {
          for (const p of parts) {
            query = query.or(
              `title.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%`
            );
          }
        } else {
          query = query.or(
            `title.ilike.%${cleanQuery}%,location.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%`
          );
        }
      }
    }
  return query;
}
