export interface LandingCard {
  id: string;
  title: string;
  body: string;
  tag: string;
  initials: string;
  avatarBg: string;
}

export function getLandingCards(_rolesCount?: string): LandingCard[] {
  return [
    {
      id: "card-1",
      title: "Employer Career Pages",
      body: "Pulls openings directly from employer career pages.",
      tag: "Example",
      initials: "JS",
      avatarBg: "bg-blue-600",
    },
    {
      id: "card-2",
      title: "ATS Resume Diagnostics",
      body: "Scores your resume against specific role requirements to identify missing keywords and formatting gaps.",
      tag: "Example",
      initials: "AK",
      avatarBg: "bg-emerald-600",
    },
    {
      id: "card-3",
      title: "AI Resume Tailoring",
      body: "Refines your bullet points and generates tailored cover letters matching target job descriptions.",
      tag: "Example",
      initials: "ML",
      avatarBg: "bg-violet-600",
    },
    {
      id: "card-4",
      title: "Remote & Location Filters",
      body: "Filters positions by worldwide eligibility, regional remote availability, and posted salary ranges.",
      tag: "Example",
      initials: "RT",
      avatarBg: "bg-amber-600",
    },
    {
      id: "card-5",
      title: "Direct ATS Links",
      body: "Provides direct links to apply on official Greenhouse, Lever, Ashby, and Workable company job boards.",
      tag: "Example",
      initials: "DC",
      avatarBg: "bg-indigo-600",
    },
    {
      id: "card-6",
      title: "Saved Job Tracking",
      body: "Organizes your search pipeline, tracks active submissions, and monitors status updates in one dashboard.",
      tag: "Example",
      initials: "NW",
      avatarBg: "bg-teal-600",
    },
    {
      id: "card-7",
      title: "Direct Application Links",
      body: "Links to the employer's own application page.",
      tag: "Example",
      initials: "EP",
      avatarBg: "bg-rose-600",
    },
    {
      id: "card-8",
      title: "ATS Keyword Alignment",
      body: "Pinpoints technical terms and domain qualifications expected by employer screening filters.",
      tag: "Example",
      initials: "BH",
      avatarBg: "bg-cyan-600",
    },
    {
      id: "card-9",
      title: "Structured Pay Visibility",
      body: "Extracts parsed salary ranges and compensation details directly from primary employer listings.",
      tag: "Example",
      initials: "SL",
      avatarBg: "bg-purple-600",
    },
    {
      id: "card-10",
      title: "Tailored Bullet Refinement",
      body: "Highlights relevant competencies and quantified accomplishments matching employer requirements.",
      tag: "Example",
      initials: "TC",
      avatarBg: "bg-sky-600",
    },
    {
      id: "card-11",
      title: "Application Pipeline",
      body: "Tracks target companies, applied positions, and interview milestones in a structured workflow.",
      tag: "Example",
      initials: "VR",
      avatarBg: "bg-orange-600",
    },
    {
      id: "card-12",
      title: "Primary Employer Sources",
      body: "Discovers openings directly on primary company hiring portals and ATS endpoints.",
      tag: "Example",
      initials: "OG",
      avatarBg: "bg-slate-700",
    },
  ];
}
