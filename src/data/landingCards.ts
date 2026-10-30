export interface LandingCard {
  id: string;
  authorName: string;
  location: string;
  body: string;
  initials: string;
  avatarBg: string;
  avatar: string;
}

export function getLandingCards(_rolesCount?: string): LandingCard[] {
  return [
    {
      id: "card-1",
      authorName: "Rohan S.",
      location: "Bengaluru",
      body: "Honestly didn't expect much but found an early-stage startup role here that wasn't on Naukri at all. Resume score feature is quite strict though!",
      initials: "RS",
      avatarBg: "bg-blue-600",
      avatar: "/images/avatars/male-1.webp",
    },
    {
      id: "card-2",
      authorName: "Pooja Verma",
      location: "Pune",
      body: "The AI editor caught so many formatting flaws in my CV. Got two interview callbacks within 10 days of fixing my score.",
      initials: "PV",
      avatarBg: "bg-emerald-600",
      avatar: "/images/avatars/female-1.webp",
    },
    {
      id: "card-3",
      authorName: "Aditya K.",
      location: "Gurgaon",
      body: "Job market is brutal right now, applying on LinkedIn felt useless. Found my current role through this scraper in the first week itself.",
      initials: "AK",
      avatarBg: "bg-violet-600",
      avatar: "/images/avatars/male-2.webp",
    },
    {
      id: "card-4",
      authorName: "Sneha M.",
      location: "Hyderabad",
      body: "Resume scanner is super helpful, pointed out missing action verbs immediately. Site took a few seconds to load the jobs list once, but good tool overall.",
      initials: "SM",
      avatarBg: "bg-amber-600",
      avatar: "/images/avatars/female-2.webp",
    },
    {
      id: "card-5",
      authorName: "Tanmay Das",
      location: "Kolkata",
      body: "Loved that it cuts through the usual sponsored listings garbage. Re-wrote my project points using the suggestions and my profile looks way sharper.",
      initials: "TD",
      avatarBg: "bg-indigo-600",
      avatar: "/images/avatars/male-3.webp",
    },
    {
      id: "card-6",
      authorName: "Kavita R.",
      location: "Mumbai",
      body: "Such a clean concept. Most platforms just repost the same 50 corporate openings, but here I actually saw genuine hidden vacancies.",
      initials: "KR",
      avatarBg: "bg-teal-600",
      avatar: "/images/avatars/female-3.webp",
    },
    {
      id: "card-7",
      authorName: "Brett H.",
      location: "Austin, TX",
      body: "Tired of competing with 800 applicants on every single posting. The scraper pulled a niche seed-round role that fit my background cleanly.",
      initials: "BH",
      avatarBg: "bg-rose-600",
      avatar: "/images/avatars/male-4.webp",
    },
    {
      id: "card-8",
      authorName: "Elena C.",
      location: "Seattle, WA",
      body: "UI has a few rough edges, but the scraped job feed is legit. Easily saved me 10+ hours of doomscrolling this week.",
      initials: "EC",
      avatarBg: "bg-cyan-600",
      avatar: "/images/avatars/female-4.webp",
    },
    {
      id: "card-9",
      authorName: "Marcus T.",
      location: "Chicago, IL",
      body: "Resume review pointed out my bullets were way too wordy and gave me concrete fixes. Landed an interview 4 days later.",
      initials: "MT",
      avatarBg: "bg-purple-600",
      avatar: "/images/avatars/male-5.webp",
    },
    {
      id: "card-10",
      authorName: "Lin Wei",
      location: "Shanghai",
      body: "Applying for remote global roles from China is usually painful. This helped me find open global positions that never show up locally.",
      initials: "LW",
      avatarBg: "bg-sky-600",
      avatar: "/images/avatars/female-5.webp",
    },
    {
      id: "card-11",
      authorName: "Chen Hao",
      location: "Beijing",
      body: "English resume scoring gave very practical suggestions for Western ATS systems. Fixed my grammar issues and boosted my score to 88.",
      initials: "CH",
      avatarBg: "bg-orange-600",
      avatar: "/images/avatars/male-6.webp",
    },
    {
      id: "card-12",
      authorName: "Yifei Z.",
      location: "Shenzhen",
      body: "Very useful for discovering stealth and cross-border startups. Good tool, already recommended it to two college friends.",
      initials: "YZ",
      avatarBg: "bg-slate-700",
      avatar: "/images/avatars/female-6.webp",
    },
  ];
}
