import { createClient } from "@/lib/supabase/client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { expandCategoryFilter, normalizeCategorySlug } from "@/lib/taxonomy";
import type { Job } from "@/data/jobs";
import { sanitizeExternalUrl, stripHtmlAndExecutableMarkup } from "@/lib/security/xss";
import { parseSearchJobsFacetRows, parseSearchJobsRows } from "./clientSchemas";
import { COUNTRY_CODE_TO_NAME } from "@/lib/countries";

export interface SearchJobsParams {
  q?: string;
  city?: string;
  cat?: string;
  categories?: string[];
  country?: string;
  remote?: boolean;
  salary?: string;
  experience?: string;
  date?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchJobsResult {
  jobs: Job[];
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  facets: {
    categories: Record<string, number>;
    countries: Record<string, number>;
  };
  availableCountries: string[];
}

// Allowlisted values
const ALLOWED_SALARY = new Set(["all", "100k", "150k", "200k"]);
const ALLOWED_EXPERIENCE = new Set(["all", "fresher", "mid", "senior"]);
const ALLOWED_DATE = new Set(["all", "24h", "7d", "30d"]);

// Card fields only — no description or skills bloat
const CARD_FIELDS =
  "id, title, company, location, remote, remote_scope, job_type, salary_text, first_seen_at, last_seen_at, posted_at, status, category, country, country_code, apply_url";

/**
 * Sanitizes user input to prevent SQL and PostgREST injection syntax breakage.
 * Strips special control characters (% _ ( ) , " ' ` ; \ $ *) and limits query length.
 */
export function sanitizeSearchQuery(input: string): string {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export async function searchJobs(
  params: SearchJobsParams = {},
  clientOverride?: any
): Promise<SearchJobsResult> {
  const isServerWithServiceKey =
    typeof window === "undefined" && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabase =
    clientOverride ||
    (isServerWithServiceKey
      ? createSupabaseClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co",
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )
      : createClient());
  const targetTable = isServerWithServiceKey ? "jobs" : "jobs_public";

  // Parameter validation and allowlisting
  const q = sanitizeSearchQuery(params.q || "");
  const city = sanitizeSearchQuery(params.city || "");
  const salary = ALLOWED_SALARY.has(params.salary || "") ? params.salary! : "all";
  const experience = ALLOWED_EXPERIENCE.has(params.experience || "") ? params.experience! : "all";
  const date = ALLOWED_DATE.has(params.date || "") ? params.date! : "all";
  const country = params.country && params.country !== "all" ? params.country : "all";
  const remoteOnly = Boolean(params.remote);

  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(50, Math.max(1, params.pageSize || 10));

  // Consolidate categories
  const categoryTokens: string[] = [];
  if (params.cat && params.cat !== "all") categoryTokens.push(params.cat);
  if (params.categories && params.categories.length > 0) {
    categoryTokens.push(...params.categories);
  }

  // Direct PostgREST query (uses jobs_public for client/anon to preserve paid-field masking, or jobs on server with service role)
  let query = supabase.from(targetTable).select(CARD_FIELDS, { count: "exact" }).eq("status", "active");

  if (q) {
    query = query.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
  }

  if (city) {
    query = query.ilike("location", `%${city}%`);
  }

  if (categoryTokens.length > 0) {
    if (categoryTokens.includes("trending")) {
      query = query.in("company", [
        "OpenAI",
        "Stripe",
        "Linear",
        "ElevenLabs",
        "Perplexity AI",
        "Baseten",
        "Cohere",
        "Notion",
      ]);
    } else if (categoryTokens.includes("internships")) {
      query = query.or("job_type.eq.internship,title.ilike.%internship%,title.ilike.%internships%,title.ilike.% intern %,title.ilike.intern %,title.ilike.% intern,title.ilike.%-intern%,title.ilike.%(intern)%,title.ilike.%co-op%,title.ilike.%coop%");
    } else if (categoryTokens.includes("remote")) {
      query = query.eq("remote_scope", "remote");
    } else if (categoryTokens.includes("fresher")) {
      query = query.or(
        "title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%,title.ilike.%graduate%,title.ilike.%fresher%,title.ilike.%internship%,title.ilike.% intern %,job_type.eq.internship"
      );
    } else {
      const slugs = expandCategoryFilter(categoryTokens);
      if (slugs.length > 0) {
        query = query.in("category", slugs);
      }
    }
  }

  if (country !== "all") {
    const code = country.toUpperCase();
    const countryName = COUNTRY_CODE_TO_NAME[code];
    if (countryName) {
      if (code === "IN") {
        query = query.or("country_code.eq.IN,country.eq.India,and(location.ilike.%India%,location.not.ilike.%Indiana%)");
      } else if (code === "MX") {
        query = query.or("country_code.eq.MX,country.eq.Mexico,and(location.ilike.%Mexico%,location.not.ilike.%New Mexico%)");
      } else {
        query = query.or(`country_code.eq.${code},country.eq.${countryName},location.ilike.%${countryName}%`);
      }
    } else {
      const sanitized = sanitizeSearchQuery(country);
      if (sanitized) {
        query = query.eq("country", sanitized);
      }
    }
  }

  if (remoteOnly) {
    query = query.eq("remote_scope", "remote");
    if (country !== "all" && country.toLowerCase() === "india") {
      query = query.or("country.eq.India,location.ilike.%worldwide%,and(location.ilike.%india%,location.not.ilike.%indiana%)");
    }
  }

  if (date !== "all") {
    const ms =
      date === "24h"
        ? 24 * 60 * 60 * 1000
        : date === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : date === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : 0;
    if (ms > 0) {
      const cutoff = new Date(Date.now() - ms).toISOString();
      query = query.gte("first_seen_at", cutoff);
    }
  }

  if (experience === "fresher") {
    query = query.or(
      "title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%,title.ilike.%graduate%,title.ilike.%fresher%,title.ilike.%intern%"
    );
  } else if (experience === "senior") {
    query = query.or(
      "title.ilike.%senior%,title.ilike.%lead%,title.ilike.%staff%,title.ilike.%principal%,title.ilike.%director%"
    );
  } else if (experience === "mid") {
    query = query.or(
      "title.ilike.%mid %,title.ilike.%mid-level%,title.ilike.%intermediate%,title.ilike.%level 2%,title.ilike.%l2%,title.ilike.%sde 2%,title.ilike.%sde ii%"
    );
  }

  if (salary !== "all") {
    const p200Prefixes = [
      "$200", "$205", "$210", "$215", "$220", "$225", "$230", "$235", "$240", "$245",
      "$250", "$255", "$260", "$265", "$270", "$275", "$280", "$285", "$290", "$295",
      "$300", "$310", "$320", "$330", "$340", "$350", "$360", "$370", "$380", "$390",
      "$400", "$450", "$500"
    ];
    const p150Prefixes = [
      "$150", "$155", "$160", "$165", "$170", "$175", "$180", "$185", "$190", "$195"
    ];
    const p100Prefixes = [
      "$100", "$105", "$110", "$115", "$120", "$125", "$130", "$135", "$140", "$145"
    ];

    if (salary === "200k") {
      query = query.or(p200Prefixes.map((p) => `salary_text.ilike.${p}%`).join(","));
    } else if (salary === "150k") {
      const orClauses = [...p150Prefixes, ...p200Prefixes].map((p) => `salary_text.ilike.${p}%`).join(",");
      query = query.or(orClauses);
    } else if (salary === "100k") {
      const orClauses = [...p100Prefixes, ...p150Prefixes, ...p200Prefixes].map((p) => `salary_text.ilike.${p}%`).join(",");
      query = query.or(orClauses);
    }
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  query = query
    .order("first_seen_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  const { data, count, error } = await query;

  if (error) {
    throw error;
  }

  const total = count || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const validatedJobs = parseSearchJobsRows(data ?? []);

  const mappedJobs: Job[] = validatedJobs.map((d) => ({
    id: d.id,
    title: stripHtmlAndExecutableMarkup(d.title),
    company: stripHtmlAndExecutableMarkup(d.company),
    location: stripHtmlAndExecutableMarkup(d.location),
    date: d.date || (d.first_seen_at ? new Date(d.first_seen_at).toLocaleDateString() : "Today"),
    salary: d.salary_text || "Competitive",
    category: d.category || "software",
    remote: d.remote === true || d.remote_scope === "remote",
    country: d.country_code || d.country || "",
    type:
      d.job_type === "full-time"
        ? "Full-time"
        : d.job_type === "job"
        ? "Full-time"
        : d.job_type || "Full-time",
    directSource: true,
    applyUrl: sanitizeExternalUrl(d.apply_url) || "#",
  }));

  // Calculate facet counts for categories and countries based on current filtered results
  let facetQuery = supabase.from("jobs_public").select("category, country").eq("status", "active");
  if (q) {
    facetQuery = facetQuery.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
  }
  if (remoteOnly) {
    facetQuery = facetQuery.eq("remote_scope", "remote");
  }
  facetQuery = facetQuery.limit(1000);

  const { data: facetData } = await facetQuery;
  const categoryFacets: Record<string, number> = {};
  const countryFacets: Record<string, number> = {};
  const availableSet = new Set<string>();

  if (facetData != null) {
    const validatedFacets = parseSearchJobsFacetRows(facetData);
    validatedFacets.forEach((row) => {
      if (row.category) {
        const canonical = normalizeCategorySlug(row.category);
        categoryFacets[canonical] = (categoryFacets[canonical] || 0) + 1;
      }
      if (row.country) {
        countryFacets[row.country] = (countryFacets[row.country] || 0) + 1;
        availableSet.add(row.country);
      }
    });
  }

  const availableCountries =
    availableSet.size > 0
      ? Array.from(availableSet).sort()
      : [
          "Australia",
          "Canada",
          "France",
          "Germany",
          "India",
          "Remote",
          "Sweden",
          "Switzerland",
          "United Kingdom",
          "United States",
        ];

  return {
    jobs: mappedJobs,
    total,
    totalPages,
    page,
    pageSize,
    facets: {
      categories: categoryFacets,
      countries: countryFacets,
    },
    availableCountries,
  };
}
