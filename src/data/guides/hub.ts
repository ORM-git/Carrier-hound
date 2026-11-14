// TODO: REPLACE WITH REAL CONTENT
export interface Trailhead {
  id: string;
  title: string;
  description: string;
  href: string;
}

export interface HubGuideItem {
  id: string;
  title: string;
  description: string;
  href: string;
  tag?: string;
}

export interface CareerRoute {
  id: string;
  title: string;
  description: string;
  href: string;
  roleCount: number;
}

export interface WorkStyleItem {
  id: string;
  title: string;
  description: string;
  href: string;
}

export const HUB_DATA = {
  hero: {
    title: "Navigate the unindexed job market with verified employer intel.",
    lede: "Curated trailheads, compensation breakdowns, and battle-tested strategies to bypass 500-applicant queues and land directly on company hiring desks.",
  },
  trailheads: [
    {
      id: "trail-1",
      title: "Discover Stealth Opportunities",
      description: "Learn how modern high-growth ventures hire before syndicating roles to public aggregators.",
      href: "/remote/hidden-job-market-guide",
    },
    {
      id: "trail-2",
      title: "Evaluate Subscription Boards",
      description: "A comprehensive breakdown comparing traditional paid databases against direct employer career feeds.",
      href: "/remote/flexjobs-alternative-review",
    },
    {
      id: "trail-3",
      title: "Master Role Title Ladders",
      description: "Map title conventions, seniority benchmarks, and salary ranges across global tech employers.",
      href: "/remote/devops-engineer/titles",
    },
  ] as Trailhead[],
  fieldNote: {
    badge: "FIELD NOTE #42",
    heading: "The 72-Hour Application Window Hypothesis",
    text: "Empirical telemetry across 45,000 engineering requisitions indicates that candidates applying within 72 hours of first ATS commit receive a 4.2x higher interview invitation rate compared to later cycles.",
    buttonText: "Read telemetry report",
    buttonHref: "/remote/remote-job-search-secrets",
    secondaryLinkText: "View live data feed",
    secondaryLinkHref: "/job-search/all",
  },
  practicalGuides: [
    {
      id: "pg-1",
      title: "The Unadvertised Pipeline: How High-Growth Startups Actually Source Talent",
      description: "Why 65% of specialized engineering and design requisitions are filled through direct career links before recruiter syndication.",
      href: "/remote/hidden-job-market-guide",
      tag: "STRATEGY",
    },
    {
      id: "pg-2",
      title: "Independent Review: Paid Membership Boards vs. Direct Automated Tracking",
      description: "An unbiased analysis comparing traditional closed job boards against verified direct employer listings.",
      href: "/remote/flexjobs-alternative-review",
      tag: "ANALYSIS",
    },
    {
      id: "pg-3",
      title: "The Zero-Ghost Protocol: Identifying Phantom Job Listings in 3 Seconds",
      description: "Five structural indicators that reveal whether an open requisition has active budget or is merely a placeholder.",
      href: "/remote/remote-job-search-secrets",
      tag: "TACTICS",
    },
    {
      id: "pg-4",
      title: "International Remote Compliance & Tax Jurisdictions Explained",
      description: "Navigating EOR contracts, 1099 versus W-8BEN agreements, and cross-border currency clauses.",
      href: "/remote/hidden-job-market-guide",
      tag: "COMPLIANCE",
    },
    {
      id: "pg-5",
      title: "Engineering Compensation Bands in 2026: North America vs. Western Europe",
      description: "Realized median salary benchmarks for Staff and Principal IC levels across Tier 1 through Tier 3 markets.",
      href: "/remote/devops-engineer/titles",
      tag: "SALARY",
    },
    {
      id: "pg-6",
      title: "Asynchronous Work Playbook: Screening for Culture Fit Before You Sign",
      description: "How to evaluate documentation maturity, meeting volume, and communication norms during technical interviews.",
      href: "/remote/remote-job-search-secrets",
      tag: "CULTURE",
    },
    {
      id: "pg-7",
      title: "Direct Outreach to Engineering Managers: Email Templates That Don't Get Ignored",
      description: "Three concise outreach scripts tailored for GitHub, personal domains, and technical Discord communities.",
      href: "/remote/hidden-job-market-guide",
      tag: "OUTREACH",
    },
    {
      id: "pg-8",
      title: "Portfolios That Convert: Showcasing Distributed Systems and Infrastructure",
      description: "A framework for presenting architecture diagrams, post-mortems, and RFC writeups to hiring managers.",
      href: "/remote/devops-engineer/titles",
      tag: "PORTFOLIO",
    },
    {
      id: "pg-9",
      title: "The First 90 Days in a Fully Remote Leadership Role",
      description: "Establishing visibility, trust, and cross-timezone momentum when leading distributed teams.",
      href: "/remote/remote-job-search-secrets",
      tag: "LEADERSHIP",
    },
    {
      id: "pg-10",
      title: "Modern Equity Compensation: RSUs, Incentive Stock Options, and Liquidity Events",
      description: "Evaluating strike prices, dilution scenarios, and secondary market opportunities in early-stage tech.",
      href: "/remote/hidden-job-market-guide",
      tag: "EQUITY",
    },
  ] as HubGuideItem[],
  careerRoutes: [
    {
      id: "cr-1",
      title: "DevOps & Cloud Infrastructure",
      description: "Kubernetes, Terraform, AWS/GCP architecture, and platform engineering ladders.",
      href: "/remote/devops-engineer/titles",
      roleCount: 14,
    },
    {
      id: "cr-2",
      title: "Product & UI/UX Design",
      description: "Design systems, interaction design, UX research, and creative leadership progressions.",
      href: "/remote/product-designer/titles",
      roleCount: 11,
    },
    {
      id: "cr-3",
      title: "Full Stack & Frontend Engineering",
      description: "Next.js, TypeScript, React internals, and web performance engineering trajectories.",
      href: "/remote/jobs/software",
      roleCount: 18,
    },
    {
      id: "cr-4",
      title: "Data Platform & Analytics Engineering",
      description: "dbt, Snowflake, Databricks, BigQuery, and modern ELT data pipelines.",
      href: "/remote/jobs/data",
      roleCount: 12,
    },
    {
      id: "cr-5",
      title: "Machine Learning & AI Systems",
      description: "LLM fine-tuning, inference serving, multimodal pipelines, and research tracks.",
      href: "/remote/jobs/devops",
      roleCount: 15,
    },
    {
      id: "cr-6",
      title: "Product Management & Operations",
      description: "Technical product discovery, roadmap orchestration, and growth optimization.",
      href: "/remote/jobs/marketing",
      roleCount: 16,
    },
  ] as CareerRoute[],
  workStyles: [
    {
      id: "ws-1",
      title: "Fully Asynchronous Workplaces",
      description: "Companies with zero mandatory real-time meetings and documentation-first cultures.",
      href: "/remote/hidden-job-market-guide",
    },
    {
      id: "ws-2",
      title: "Timezone-Agnostic Global Teams",
      description: "Employers hiring worldwide with no geographic restrictions or pay localization penalties.",
      href: "/remote/remote-job-search-secrets",
    },
    {
      id: "ws-3",
      title: "Four-Day Work Week Organizations",
      description: "Verified companies operating on a 32-hour standard work week with 100% compensation.",
      href: "/remote/flexjobs-alternative-review",
    },
    {
      id: "ws-4",
      title: "High-Autonomy Flat Structures",
      description: "Engineering-led startups with minimal middle management and high individual contributor leverage.",
      href: "/remote/devops-engineer/titles",
    },
  ] as WorkStyleItem[],
};
