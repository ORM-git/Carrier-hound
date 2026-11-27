/**
 * Display-only hide policy (checklist #44, owner-settled 26 Nov): a job with no proper employer logo is not
 * shown in the jobs list. Rows are never deleted or modified; this only filters what the list renders.
 *
 * "Proper" here means a logo source exists for the employer: a stored (resolver-validated) logo URL on the
 * company or job, or a stored company domain. A job with neither can only ever render a letter tile.
 * A logo that fails to load is detected at render time: CompanyLogo reports when every candidate image has failed
 * (onUnresolved) and the page then hides that job too. Invisible-on-tile (white) logos are not detected client-side.
 *
 * Applies only where the employer is shown (Pro). Free/guest rows are masked and carry no logo or domain,
 * so the policy cannot and must not be applied to them. Saved/applied/hidden views are the user's own
 * records and are never thinned.
 */
type LogoFields = { logoUrl?: string | null; companyLogoUrl?: string | null; companyDomain?: string | null };

const usableUrl = (u?: string | null) => {
  const v = (u || "").trim();
  return v.startsWith("https://") || v.startsWith("http://") || v.startsWith("/");
};

export function hasEmployerLogoSource(job: LogoFields): boolean {
  return usableUrl(job.companyLogoUrl) || usableUrl(job.logoUrl) || Boolean((job.companyDomain || "").trim());
}

export function shouldApplyLogoHidePolicy(args: { isPro: boolean; activeTab: string; viewingHidden: boolean }): boolean {
  if (!args.isPro || args.viewingHidden) return false;
  return !["saved", "liked", "applied"].includes(args.activeTab);
}

type PolicyArgs = { isPro: boolean; activeTab: string; viewingHidden: boolean; unresolvedIds?: ReadonlySet<string> };

/**
 * Jobs the policy hides: no logo source at all, or the rendered logo could not be loaded (every candidate image
 * failed, reported by CompanyLogo through onUnresolved and held in unresolvedIds).
 */
export function isLogoHidden<T extends LogoFields & { id: string }>(job: T, args: PolicyArgs): boolean {
  return !hasEmployerLogoSource(job) || Boolean(args.unresolvedIds?.has(job.id));
}

export function applyLogoHidePolicy<T extends LogoFields & { id: string }>(jobs: T[], args: PolicyArgs): T[] {
  return shouldApplyLogoHidePolicy(args) ? jobs.filter((j) => !isLogoHidden(j, args)) : jobs;
}

/**
 * Count shown in the first-visit welcome ("We found N roles"). The server total counts jobs this policy may
 * hide, and the hidden share of unloaded pages is unknown, so once anything has been hidden no number is
 * claimed (null = generic copy) rather than an overstated or guessed one.
 */
export function welcomeRecommendedCount(args: { isDegraded: boolean; logoHidAny: boolean; totalCount: number; loaded: number }): number | null {
  if (args.isDegraded || args.logoHidAny) return null;
  return Math.min(args.totalCount || args.loaded, 30);
}
