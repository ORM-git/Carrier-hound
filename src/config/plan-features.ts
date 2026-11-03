/**
 * src/config/plan-features.ts
 *
 * Config for the 7 feature comparison rows for CareerMonke Premium.
 * Sourced directly from our real platform capabilities and approved quotas.
 */

export interface PlanFeatureRow {
  name: string;
  info: string;
  premium: string;
  free: string;
}

export const PLAN_FEATURE_ROWS: PlanFeatureRow[] = [
  {
    name: "Job extraction",
    info: "Sets per plan quota from verified employer career pages",
    premium: "Weekly 15 sets/wk, Monthly 60 sets/mo, Quarterly 60 sets/mo x 3",
    free: "-",
  },
  {
    name: "AI tailored resume",
    info: "Tailor resume directly to job requirements",
    premium: "Weekly 15 sets/wk, Monthly 60 sets/mo, Quarterly 60 sets/mo x 3",
    free: "-",
  },
  {
    name: "AI cover letter",
    info: "Personalized pitch and cover letter for each role",
    premium: "Weekly 15 sets/wk, Monthly 60 sets/mo, Quarterly 60 sets/mo x 3",
    free: "-",
  },
  {
    name: "Hybrid AI match score",
    info: "Grounded match diagnostics and skill breakdown",
    premium: "Planned",
    free: "-",
  },
  {
    name: "Unlimited job browsing",
    info: "Search unindexed remote tech jobs across verified employers",
    premium: "Unlimited",
    free: "Unlimited",
  },
  {
    name: "Rule-based match score",
    info: "Deterministic skill and seniority compatibility score",
    premium: "Included",
    free: "-",
  },
  {
    name: "Daily generation limit (30/day)",
    info: "Anti-abuse rate limit to protect system performance",
    premium: "30/day",
    free: "-",
  },
];
