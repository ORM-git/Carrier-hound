import { createClient } from "@supabase/supabase-js";
import { WORLDWIDE_COMPANIES, WorldwideCompany } from "@/data/companies";
import { createLogger } from "@/lib/observability/logger";
import {
  ClientSchemaValidationError,
  parseWorldwideCompanyRows,
} from "./clientSchemas";

const log = createLogger({ context: { module: "api/worldwide" } });

export interface WorldwideCompanyRow {
  name: string;
  slug: string;
  country?: string;
  active_job_count?: number;
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false },
  });
}

/**
 * Loads worldwide company counts server-side / build-time.
 * Strictly falls back to the static catalog (src/data/companies.json) if the view
 * does not exist yet, on network/query failure, or if credentials are not configured.
 *
 * Ensures only safe public fields (id, name, slug, country, jobCount) are returned,
 * preserving zero leakage of paid job details.
 */
export async function getWorldwideCompanies(clientOverride?: any): Promise<WorldwideCompany[]> {
  try {
    const client = clientOverride !== undefined ? clientOverride : getSupabaseClient();
    if (!client) {
      return WORLDWIDE_COMPANIES;
    }

    const { data, error } = await client
      .from("worldwide_company_counts")
      .select("name, slug, country, active_job_count");

    if (error || data == null) {
      return WORLDWIDE_COMPANIES;
    }

    const validatedRows = parseWorldwideCompanyRows(data);
    if (validatedRows.length === 0) {
      return WORLDWIDE_COMPANIES;
    }

    const countMap = new Map<string, number>();
    for (const row of validatedRows) {
      const slug = row.slug.toLowerCase().trim();
      const count = row.active_job_count;
      if (slug && count > 0) {
        countMap.set(slug, count);
      }
    }

    if (countMap.size === 0) {
      return WORLDWIDE_COMPANIES;
    }

    // Merge live counts with static whitelist, keeping fallback order and fields
    return WORLDWIDE_COMPANIES.map((company) => {
      const liveCount = countMap.get(company.slug.toLowerCase());
      if (liveCount !== undefined) {
        return {
          id: company.id,
          name: company.name,
          slug: company.slug,
          country: company.country,
          jobCount: liveCount,
        };
      }
      return {
        id: company.id,
        name: company.name,
        slug: company.slug,
        country: company.country,
        jobCount: company.jobCount,
      };
    });
  } catch (err) {
    if (err instanceof ClientSchemaValidationError) {
      log.warn("CLIENT_SCHEMA_VALIDATION_FAILED", {
        schema: err.schema,
        reason: err.reason,
      });
    }
    return WORLDWIDE_COMPANIES;
  }
}
