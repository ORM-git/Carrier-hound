export interface LandingCard {
  id: string;
  title: string;
  body: string;
  tag: string;
  iconName: string;
}

export function getLandingCards(rolesCount?: string): LandingCard[] {
  const countDisplay = rolesCount || "10,000+";

  return [
    {
      id: "card-1",
      title: "Direct ATS Application Links",
      body: "Apply directly on official Greenhouse, Lever, Ashby, Workable, and SmartRecruiters employer job boards.",
      tag: "Direct ATS Links",
      iconName: "ExternalLink",
    },
    {
      id: "card-2",
      title: "Active Verified Roles Indexed",
      body: `Over ${countDisplay} open positions indexed from verified company career pages.`,
      tag: "Live Role Index",
      iconName: "Layers",
    },
    {
      id: "card-3",
      title: "AI Resume Diagnostics",
      body: "Actionable scoring on ATS keyword alignment, formatting hurdles, and structural clarity.",
      tag: "AI Resume Score",
      iconName: "Sparkles",
    },
    {
      id: "card-4",
      title: "Targeted Role Tailoring",
      body: "Tailor your experience and bullet points to match requirements for specific open roles.",
      tag: "Resume Tailoring",
      iconName: "FileText",
    },
    {
      id: "card-5",
      title: "Remote & Worldwide Filters",
      body: "Filter positions by worldwide eligibility, regional remote availability, and country criteria.",
      tag: "Remote Filters",
      iconName: "Globe",
    },
    {
      id: "card-6",
      title: "Built-In Application Tracker",
      body: "Organize your job hunt pipeline, save openings, and manage statuses from application to offer.",
      tag: "Application Tracker",
      iconName: "BookmarkCheck",
    },
    {
      id: "card-7",
      title: "Greenhouse & Lever Indexing",
      body: "Direct integration with Greenhouse and Lever career portals for verified primary listings.",
      tag: "Greenhouse & Lever",
      iconName: "Link2",
    },
    {
      id: "card-8",
      title: "Ashby & Workable Portals",
      body: "Discover postings hosted on Ashby, Workable, and SmartRecruiters hiring boards.",
      tag: "ATS Boards",
      iconName: "Briefcase",
    },
    {
      id: "card-9",
      title: "ATS Keyword Matching",
      body: "Identify missing skills and technical keywords expected by corporate ATS screening algorithms.",
      tag: "Keyword Matching",
      iconName: "CheckCircle2",
    },
    {
      id: "card-10",
      title: "Worldwide Remote Listings",
      body: "Surface cross-border and international remote positions open to global applicants.",
      tag: "Worldwide Roles",
      iconName: "Compass",
    },
    {
      id: "card-11",
      title: "Application Pipeline Stages",
      body: "Keep track of active leads, submitted applications, and upcoming interview stages.",
      tag: "Pipeline Management",
      iconName: "Kanban",
    },
    {
      id: "card-12",
      title: "Tailored Bullet Refinements",
      body: "Refine resume bullets to highlight relevant competencies matching employer job descriptions.",
      tag: "Bullet Refinement",
      iconName: "FileEdit",
    },
  ];
}
