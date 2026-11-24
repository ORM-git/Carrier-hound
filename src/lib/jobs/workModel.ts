/**
 * Work-model label from remote_scope (remote / worldwide / hybrid / onsite / any / a regional scope)
 * with the remote flag and location as fallbacks. Hybrid is checked first so it is never shown as On-site.
 */
export function workModelLabel(job: { remote?: boolean; remoteScope?: string | null; location?: string | null }): "Remote" | "Hybrid" | "On-site" | "Flexible" {
  const scope = (job.remoteScope || "").trim().toLowerCase();
  const location = (job.location || "").toLowerCase();
  if (scope === "hybrid" || /\bhybrid\b/.test(location)) return "Hybrid";
  if (scope === "onsite" || scope === "on-site" || scope === "on_site") return "On-site";
  if (scope === "any") return "Flexible";
  if (job.remote || scope === "remote" || scope === "worldwide") return "Remote";
  return "On-site";
}
