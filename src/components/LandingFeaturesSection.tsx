import React from "react";
import Link from "next/link";

interface FeatureRow {
  id: string;
  title: string;
  description: string;
  buttonText: string;
  href: string;
  visual: React.ReactNode;
}

const FEATURE_ROWS: FeatureRow[] = [
  {
    id: "job-search",
    title: "Find jobs on company career pages",
    description: "Search roles posted directly on employer career sites.",
    buttonText: "Explore jobs",
    href: "/jobs",
    visual: <cm-find-jobs compact />,
  },
  {
    id: "tailored-resume",
    title: "Tailor your resume to each role",
    description: "Get a resume and cover letter draft matched to the job.",
    buttonText: "Try AI resume tools",
    href: "/signup",
    visual: <cm-tailor-resume compact />,
  },
  {
    id: "personalized-matches",
    title: "Personalized job matches",
    description: "See how well your skills fit each role.",
    buttonText: "Find my matches",
    href: "/signup",
    visual: <cm-job-matches compact />,
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
              </div>

              {/* Visual Column (Bottom on mobile, Right on desktop) */}
              <div className="lg:col-span-7 space-y-3">
                <div className="flex items-center justify-center overflow-hidden">
                  {row.visual}
                </div>

                {/* Horizontally centered CTA directly below the visual */}
                <div className="flex justify-center pt-2">
                  <Link
                    href={row.href}
                    className="inline-flex items-center justify-center px-6 py-3 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium text-sm sm:text-base transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:ring-offset-2"
                  >
                    {row.buttonText}
                  </Link>
                </div>

                {/* Visible caption beneath centered button */}
                <p className="text-center text-xs text-gray-400">
                  Illustration - sample data
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
