import Image from "next/image";
import Link from "next/link";

interface FeatureRow {
  id: string;
  title: string;
  description: string;
  image: string;
  buttonText?: string;
  href?: string;
  badge?: string;
}

const FEATURE_ROWS: FeatureRow[] = [
  {
    id: "job-search",
    title: "Find jobs on company career pages",
    description: "Search roles posted directly on employer career sites.",
    image: "/features/job-search.webp",
    buttonText: "Explore jobs",
    href: "/jobs",
  },
  {
    id: "tailored-resume",
    title: "Tailor your resume to each role",
    description: "Get a resume and cover letter draft matched to the job.",
    image: "/features/tailored-resume.webp",
    buttonText: "Try AI resume tools",
    href: "/resume",
  },
  {
    id: "autofill-extension",
    title: "Autofill applications",
    description: "Coming soon.",
    image: "/features/autofill-extension.webp",
    badge: "Coming soon",
  },
  {
    id: "interview-prep",
    title: "AI interview prep",
    description: "Coming soon.",
    image: "/features/interview-prep.webp",
    badge: "Coming soon",
  },
  {
    id: "personalized-matches",
    title: "Personalized AI job matches",
    description: "See how well your skills fit each role.",
    image: "/features/personalized-matches.webp",
    buttonText: "Find my matches",
    href: "/jobs",
  },
];

export default function LandingFeaturesSection() {
  return (
    <section
      id="features"
      data-testid="landing-features-section"
      aria-label="Features"
      className="py-16 sm:py-24 bg-white border-t border-gray-200/70"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="space-y-16 sm:space-y-24">
          {FEATURE_ROWS.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-1 lg:grid-cols-12 items-center gap-8 lg:gap-12"
            >
              {/* Text Column (Top on mobile, Left on desktop) */}
              <div className="lg:col-span-5 space-y-4 text-left">
                <h3 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090B]">
                  {row.title}
                </h3>
                <p className="text-base sm:text-lg text-gray-600 leading-relaxed">
                  {row.description}
                </p>
                {row.badge ? (
                  <div className="pt-2">
                    <span className="inline-flex items-center px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-medium bg-gray-100 text-gray-600 border border-gray-200">
                      {row.badge}
                    </span>
                  </div>
                ) : row.buttonText && row.href ? (
                  <div className="pt-2">
                    <Link
                      href={row.href}
                      className="inline-flex items-center justify-center px-6 py-3 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium text-sm sm:text-base transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:ring-offset-2"
                    >
                      {row.buttonText}
                    </Link>
                  </div>
                ) : null}
              </div>

              {/* Image Column (Bottom on mobile, Right on desktop) */}
              <div className="lg:col-span-7">
                <div className="bg-[#F8FAFC] rounded-2xl border border-gray-200/80 shadow-sm p-3 sm:p-5 flex items-center justify-center overflow-hidden">
                  <Image
                    src={row.image}
                    alt={row.title}
                    width={1024}
                    height={1024}
                    loading="lazy"
                    className="w-full h-auto rounded-xl object-contain"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Small caption under the section */}
        <p className="text-center text-xs text-gray-400 mt-12 sm:mt-16">
          Illustration - sample data
        </p>
      </div>
    </section>
  );
}
