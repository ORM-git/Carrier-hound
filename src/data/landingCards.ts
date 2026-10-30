export interface LandingCard {
  id: string;
  title: string;
  body: string;
  tag?: string;
  initials: string;
  avatarBg: string;
  avatar: string;
  authorName: string;
}

export function getLandingCards(_rolesCount?: string): LandingCard[] {
  return [
    {
      id: "card-1",
      authorName: "Alex Rivera",
      title: "Employer Career Pages",
      body: "Pulls openings directly from employer career pages.",
      initials: "AR",
      avatarBg: "bg-blue-600",
      avatar: "/images/avatars/male-1.webp",
    },
    {
      id: "card-2",
      authorName: "Sarah Jenkins",
      title: "ATS Resume Diagnostics",
      body: "Scores your resume against specific role requirements to identify missing keywords and formatting gaps.",
      initials: "SJ",
      avatarBg: "bg-emerald-600",
      avatar: "/images/avatars/female-1.webp",
    },
    {
      id: "card-3",
      authorName: "David Chen",
      title: "AI Resume Tailoring",
      body: "Refines your bullet points and generates tailored cover letters matching target job descriptions.",
      initials: "DC",
      avatarBg: "bg-violet-600",
      avatar: "/images/avatars/male-2.webp",
    },
    {
      id: "card-4",
      authorName: "Priya Sharma",
      title: "Remote & Location Filters",
      body: "Filters positions by worldwide eligibility, regional remote availability, and posted salary ranges.",
      initials: "PS",
      avatarBg: "bg-amber-600",
      avatar: "/images/avatars/female-2.webp",
    },
    {
      id: "card-5",
      authorName: "Marcus Vance",
      title: "Direct ATS Links",
      body: "Provides direct links to apply on official Greenhouse, Lever, Ashby, and Workable company job boards.",
      initials: "MV",
      avatarBg: "bg-indigo-600",
      avatar: "/images/avatars/male-3.webp",
    },
    {
      id: "card-6",
      authorName: "Elena Rostova",
      title: "Saved Job Tracking",
      body: "Organizes your search pipeline, tracks active submissions, and monitors status updates in one dashboard.",
      initials: "ER",
      avatarBg: "bg-teal-600",
      avatar: "/images/avatars/female-3.webp",
    },
    {
      id: "card-7",
      authorName: "Ethan Brooks",
      title: "Direct Application Links",
      body: "Links to the employer's own application page.",
      initials: "EB",
      avatarBg: "bg-rose-600",
      avatar: "/images/avatars/male-4.webp",
    },
    {
      id: "card-8",
      authorName: "Maya Lin",
      title: "ATS Keyword Alignment",
      body: "Pinpoints technical terms and domain qualifications expected by employer screening filters.",
      initials: "ML",
      avatarBg: "bg-cyan-600",
      avatar: "/images/avatars/female-4.webp",
    },
    {
      id: "card-9",
      authorName: "James Miller",
      title: "Structured Pay Visibility",
      body: "Extracts parsed salary ranges and compensation details directly from primary employer listings.",
      initials: "JM",
      avatarBg: "bg-purple-600",
      avatar: "/images/avatars/male-5.webp",
    },
    {
      id: "card-10",
      authorName: "Chloe Bennett",
      title: "Tailored Bullet Refinement",
      body: "Highlights relevant competencies and quantified accomplishments matching employer requirements.",
      initials: "CB",
      avatarBg: "bg-sky-600",
      avatar: "/images/avatars/female-5.webp",
    },
    {
      id: "card-11",
      authorName: "Ryan Patel",
      title: "Application Pipeline",
      body: "Tracks target companies, applied positions, and interview milestones in a structured workflow.",
      initials: "RP",
      avatarBg: "bg-orange-600",
      avatar: "/images/avatars/male-6.webp",
    },
    {
      id: "card-12",
      authorName: "Olivia Taylor",
      title: "Primary Employer Sources",
      body: "Discovers openings directly on primary company hiring portals and ATS endpoints.",
      initials: "OT",
      avatarBg: "bg-slate-700",
      avatar: "/images/avatars/female-6.webp",
    },
  ];
}
