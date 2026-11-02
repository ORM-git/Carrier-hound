import Image from "next/image";
import Link from "next/link";
import { Rocket } from "lucide-react";

interface FeatureRow {
  id: string;
  title: string;
  description?: string;
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
    href: "/early-access",
  },
  {
    id: "tailored-resume",
    title: "Tailor your resume to each role",
    description: "Get a resume and cover letter draft matched to the job.",
    image: "/features/tailored-resume.webp",
    buttonText: "Try AI resume tools",
    href: "/early-access",
  },
  {
    id: "autofill-extension",
    title: "Autofill applications",
    image: "/features/autofill-extension.webp",
    badge: "Coming soon",
  },
  {
    id: "interview-prep",
    title: "AI interview prep",
    image: "/features/interview-prep.webp",
    badge: "Coming soon",
  },
  {
    id: "personalized-matches",
    title: "Personalized job matches",
    description: "See how well your skills fit each role.",
    image: "/features/personalized-matches.webp",
    buttonText: "Find my matches",
    href: "/early-access",
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
        {/* Section Heading directly above the photos */}
        <div className="mb-12 sm:mb-16 lg:mb-20 text-center lg:text-left">
          <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-[56px] font-black uppercase tracking-tight text-[#09090B] leading-[1.05] sm:leading-[1.05]">
            <span className="inline-block">
              NO.1 AI
              <sup className="ml-1 sm:ml-1.5 relative -top-1.5 sm:-top-2 md:-top-3 inline-block">
                <Rocket
                  className="w-5 h-5 sm:w-6 sm:h-6 md:w-7 md:h-7 inline-block stroke-[2.2] text-[#09090B]"
                  aria-hidden="true"
                />
              </sup>
            </span>
            <span className="block mt-1 sm:mt-2">
              JOB HUNTING PLATFORM
            </span>
          </h2>
        </div>

        <div className="space-y-16 sm:space-y-24">
          {FEATURE_ROWS.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-1 lg:grid-cols-12 items-center gap-8 lg:gap-12"
            >
              {/* Image Column (Top on mobile via order-1, Right on desktop via lg:order-2) */}
              <div className="order-1 lg:order-2 lg:col-span-7 w-full space-y-2 flex flex-col items-center">
                <div className="w-full bg-[#F8FAFC] rounded-2xl border border-gray-200/80 shadow-sm p-3 sm:p-5 flex items-center justify-center overflow-hidden">
                  <Image
                    src={row.image}
                    alt={row.title}
                    width={1024}
                    height={1024}
                    loading="lazy"
                    className="w-full h-auto rounded-xl object-contain mx-auto"
                  />
                </div>
                <p className="text-center text-xs text-gray-400 w-full">
                  Illustration - sample data
                </p>
              </div>

              {/* Text Column (Bottom on mobile via order-2, Left on desktop via lg:order-1) */}
              <div className="order-2 lg:order-1 lg:col-span-5 w-full space-y-4 text-center lg:text-left flex flex-col items-center lg:items-start">
                <h3 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#09090B] w-full">
                  {row.title}
                </h3>
                {row.description && (
                  <p className="text-base sm:text-lg text-gray-600 leading-relaxed w-full">
                    {row.description}
                  </p>
                )}
                {row.badge ? (
                  <div className="pt-2 w-full flex justify-center lg:justify-start">
                    <span className="inline-flex items-center px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-medium bg-gray-100 text-gray-600 border border-gray-200">
                      {row.badge}
                    </span>
                  </div>
                ) : row.buttonText && row.href ? (
                  <div className="pt-2 w-full flex justify-center lg:justify-start">
                    <Link
                      href={row.href}
                      className="inline-flex items-center justify-center px-6 py-3 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium text-sm sm:text-base transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:ring-offset-2"
                    >
                      {row.buttonText}
                    </Link>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
