import { createClient } from "@supabase/supabase-js";
import type { GetJobsResult, LiveJob } from "@/lib/jobs/service";

/**
 * Server-side first page of the public /jobs list (guest view).
 * Same view (jobs_public), same columns, same order and same masking as the
 * client default query in getLiveJobs: company is always "Verified Employer",
 * no salary, apply URL, description or skills. Pro unlock stays client-side.
 * Returns null on any problem so the client falls back to its own fetch.
 */
const PUBLIC_SELECT_COLUMNS =
  "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return "Recently";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffHours = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "Recently";
  }
}

export async function getInitialPublicJobs(pageSize = 50): Promise<GetJobsResult | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  try {
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(2500), cache: "no-store" }),
      },
    });

    const { data, count, error } = await supabase
      .from("jobs_public")
      .select(PUBLIC_SELECT_COLUMNS, { count: "exact" })
      .eq("is_active", true)
      .eq("status", "active")
      .order("posted_at", { ascending: false, nullsFirst: false })
      .range(0, pageSize - 1);

    if (error || !data || data.length === 0) return null;

    const jobs: LiveJob[] = data.map((row: any) => ({
      id: row.id,
      title: row.title || "Untitled Position",
      company: "Verified Employer",
      location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
      date: formatDate(row.posted_at || row.created_at),
      salary: "",
      category: row.category || "engineering",
      remote: Boolean(row.remote),
      remoteScope: row.remote_scope || undefined,
      remoteEligibility: row.remote_eligibility || undefined,
      country: row.country_code || "US",
      type: row.job_type === "internship" ? "Internship" : "Full-time",
      directSource: Boolean(row.verified),
      applyUrl: "",
      description: "",
      skills: [],
      postedAt: row.posted_at || row.created_at,
    }));

    return { jobs, totalCount: count ?? jobs.length };
  } catch {
    return null;
  }
}
