export interface LandingCard {
  id: string;
  title: string;
  body: string;
  tag: string;
  image: string;
  gender: "female" | "male";
  authorRole?: string;
}

export const LANDING_CARDS: LandingCard[] = [
  // --- Females (6) ---
  {
    id: "card-1",
    title: "Direct ATS Application Links",
    body: "Every listing links directly to the official employer career page or ATS—never an aggregator middleman or expired redirect.",
    tag: "Direct Listings",
    image: "/images/avatars/female-1.jpg",
    gender: "female",
    authorRole: "Verified Feature",
  },
  {
    id: "card-2",
    title: "22,000+ Active Roles Indexed",
    body: "Our crawlers index roles straight from Greenhouse, Lever, Ashby, and Workable company boards before they hit search engines.",
    tag: "Vault Scale",
    image: "/images/avatars/female-2.avif",
    gender: "female",
    authorRole: "Live Index",
  },
  {
    id: "card-3",
    title: "AI Resume Scoring & Fixes",
    body: "Get immediate diagnostic feedback on missing ATS keywords, weak action verbs, formatting hurdles, and structural gaps.",
    tag: "ATS Optimization",
    image: "/images/avatars/female-3.avif",
    gender: "female",
    authorRole: "Resume Tools",
  },
  {
    id: "card-4",
    title: "Remote & Worldwide Roles",
    body: "Dedicated filters for US, Europe, APAC, and anywhere-in-the-world remote eligibility without geographic ambiguity.",
    tag: "Worldwide Remote",
    image: "/images/avatars/female-4.avif",
    gender: "female",
    authorRole: "Global Filters",
  },
  {
    id: "card-5",
    title: "Tailor for Every Position",
    body: "Generate targeted bullet points aligned with specific job descriptions while keeping your authentic experience intact.",
    tag: "AI Tailoring",
    image: "/images/avatars/female-5.avif",
    gender: "female",
    authorRole: "AI Features",
  },
  {
    id: "card-6",
    title: "Fresh Listings Through the Week",
    body: "Continuous ingestion pipelines discover newly opened engineering, product, and data openings within hours of publication.",
    tag: "Fresh Indexing",
    image: "/images/avatars/female-6.avif",
    gender: "female",
    authorRole: "Real-Time Pipeline",
  },

  // --- Males (6) ---
  {
    id: "card-7",
    title: "Zero Aggregator Reposts",
    body: "No ghost jobs, expired reposts, or third-party lead traps. If a role is closed on the company career board, it's out.",
    tag: "Clean Primary Data",
    image: "/images/avatars/male-1.jpg",
    gender: "male",
    authorRole: "Primary Sources",
  },
  {
    id: "card-8",
    title: "Transparent Compensation",
    body: "View structured salary ranges wherever disclosed by hiring teams, normalized across currencies for easy comparison.",
    tag: "Salary Transparency",
    image: "/images/avatars/male-2.jpg",
    gender: "male",
    authorRole: "Comp Insights",
  },
  {
    id: "card-9",
    title: "Seniority & Stack Filters",
    body: "Filter from entry level and mid-market up to Staff and Principal engineering without wading through irrelevant postings.",
    tag: "Seniority Filters",
    image: "/images/avatars/male-3.jpg",
    gender: "male",
    authorRole: "Targeted Search",
  },
  {
    id: "card-10",
    title: "Built-In Application Tracker",
    body: "Save roles, organize your application stages, and keep your job hunt pipeline focused from first glance to offer.",
    tag: "Pipeline Tracker",
    image: "/images/avatars/male-4.avif",
    gender: "male",
    authorRole: "Search Dashboard",
  },
  {
    id: "card-11",
    title: "Fast, Static-First Search",
    body: "Zero bloated scripts or intrusive tracking. Instant facet searching and keyboard navigation built for speed.",
    tag: "Search Speed",
    image: "/images/avatars/male-5.avif",
    gender: "male",
    authorRole: "Architecture",
  },
  {
    id: "card-12",
    title: "Candidate Privacy First",
    body: "Your uploaded resume and application data remain strictly confidential. We never monetize or sell candidate data.",
    tag: "Candidate Privacy",
    image: "/images/avatars/male-6.avif",
    gender: "male",
    authorRole: "Security",
  },
];
