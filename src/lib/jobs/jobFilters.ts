/**
 * Shared Job Type / Work Model filter semantics for every jobs query path and the /jobs page:
 * OR within a selected dimension ("full-time, contract"), AND across dimensions (each clause is its own `.or()`).
 * Rows with NULL job_type never match an active Job Type filter (SQL three-valued logic), as before.
 */

/** Lowercased, trimmed, comma-separated selections without empties or "all". */
export function filterTokens(value?: string | null): string[] {
  return (value || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "all");
}

// Same characters as sanitizeSearchQuery: nothing that can break out of a PostgREST logic tree.
const clean = (s: string) => s.replace(/[%_(),"'`;\\$*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

// [substring a selection contains, matched with ilike; exact stored aliases the old clauses also listed]
const JOB_TYPES: Array<[string, string[]]> = [
  ["full", ["full-time", "full_time"]],
  ["contract", ["contractor"]],
  ["part", []],
  ["intern", ["internship"]],
];

/** Substring each selected job type matches in job_type; unknown values match themselves. */
function jobTypeKeys(value?: string | null): Array<{ key: string; exact: string[] }> {
  const out: Array<{ key: string; exact: string[] }> = [];
  for (const token of filterTokens(value)) {
    const known = JOB_TYPES.find(([k]) => token.includes(k));
    const key = known ? known[0] : clean(token);
    if (key && !out.some((o) => o.key === key)) out.push({ key, exact: known ? known[1] : [] });
  }
  return out;
}

/** PostgREST `.or()` argument for the Job Type selection, or null when no filter applies. */
export function jobTypeOrClause(value?: string | null): string | null {
  const parts = jobTypeKeys(value).flatMap(({ key, exact }) => [
    `job_type.ilike.%${key}%`,
    ...exact.map((e) => `job_type.eq.${e}`),
  ]);
  return parts.length ? parts.join(",") : null;
}

/** Client-side mirror of jobTypeOrClause for a card's job type. */
export function matchesJobTypeFilter(type: string | null | undefined, value?: string | null): boolean {
  const keys = jobTypeKeys(value);
  if (!keys.length) return true;
  const t = (type || "").toLowerCase();
  return Boolean(t) && keys.some(({ key }) => t.includes(key));
}

// Same precedence as workModelLabel (workModel.ts): a Hybrid or On-site signal wins over the remote flag, so a job
// labelled Hybrid never appears under Remote, and a remote=false job labelled Hybrid never appears under On-site.
const NOT_HYBRID = "and(or(location.is.null,location.not.ilike.%hybrid%),or(remote_scope.is.null,remote_scope.neq.hybrid))";
const NOT_ONSITE_SCOPE = "or(remote_scope.is.null,and(remote_scope.neq.onsite,remote_scope.neq.on-site,remote_scope.neq.on_site))";
const NOT_REMOTE_SCOPE = "or(remote_scope.is.null,and(remote_scope.neq.remote,remote_scope.neq.worldwide,remote_scope.neq.any))";
const WORK_MODELS: Record<string, string> = {
  remote: `and(or(remote.eq.true,location.ilike.%remote%),${NOT_HYBRID},${NOT_ONSITE_SCOPE})`,
  hybrid: "location.ilike.%hybrid%,remote_scope.eq.hybrid",
  onsite: `and(or(remote.eq.false,location.ilike.%onsite%),${NOT_HYBRID},${NOT_REMOTE_SCOPE})`,
};
const workModelKeys = (value?: string | null) => filterTokens(value).filter((t) => t in WORK_MODELS);

/** PostgREST `.or()` argument for the Work Model selection (unknown values ignored), or null. */
export function workModelOrClause(value?: string | null): string | null {
  const parts = workModelKeys(value).map((t) => WORK_MODELS[t]);
  return parts.length ? parts.join(",") : null;
}

/** Client-side mirror of workModelOrClause. */
export function matchesWorkModelFilter(
  job: { remote?: boolean | null; location?: string | null; remoteScope?: string | null },
  value?: string | null
): boolean {
  const keys = workModelKeys(value);
  if (!keys.length) return true;
  const loc = (job.location || "").toLowerCase();
  const scope = (job.remoteScope || "").trim().toLowerCase();
  const hybrid = loc.includes("hybrid") || scope === "hybrid";
  const onsiteScope = scope === "onsite" || scope === "on-site" || scope === "on_site";
  return keys.some((t) =>
    t === "remote"
      ? (Boolean(job.remote) || loc.includes("remote")) && !hybrid && !onsiteScope
      : t === "hybrid"
      ? hybrid
      : (!job.remote || loc.includes("onsite")) && !hybrid && !["remote", "worldwide", "any"].includes(scope)
  );
}

/** Only a Remote-only selection may also apply the strict remoteOnly flag; Remote + Hybrid/Onsite must not. */
export function isRemoteOnlyWorkModel(value?: string | null): boolean {
  const keys = filterTokens(value);
  return keys.length > 0 && keys.every((t) => t === "remote");
}
