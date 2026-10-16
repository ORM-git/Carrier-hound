import React from "react";
import Link from "next/link";
import BrandIcon from "./BrandIcon";
import DotPattern from "./DotPattern";

interface FooterProps {
  isGuide?: boolean;
}

export default function Footer({ isGuide = false }: FooterProps) {
  return (
    <footer className="relative bg-[#090E34] text-white pt-12 sm:pt-16 pb-24 sm:pb-12 overflow-hidden border-t border-slate-800 animate-fadeInUp">
      {/* Faint dot pattern in the top-right corner */}
      <div className="absolute top-0 right-0 pointer-events-none opacity-20">
        <DotPattern width={220} height={160} dotColor="#ffffff" rows={7} cols={10} />
      </div>

      <div className="max-w-content mx-auto px-4 sm:px-6 relative z-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-8 lg:gap-10 pb-10 sm:pb-12 border-b border-slate-800/80">
          {/* Brand + Tagline */}
          <div className="sm:col-span-2 lg:col-span-6 space-y-4">
            <Link href="/" className="inline-flex items-center gap-2.5 group min-h-[44px]">
              <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center p-1 shadow-sm overflow-hidden">
                <BrandIcon className="w-8 h-8" />
              </div>
              <span className="text-2xl font-black tracking-tight text-white">CareerMonke</span>
            </Link>
            <p className="text-slate-400 text-sm max-w-md leading-relaxed">
              We find jobs posted on company websites. Real-time radar for unindexed remote engineering, design, data, and product jobs directly from verified company ATS endpoints.
            </p>
          </div>

          {/* Quick Links Column */}
          <div className="sm:col-span-1 lg:col-span-3 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">Navigation</h2>
            <ul className="space-y-1 text-sm text-slate-400">
              <li>
                <Link href="/job-search/all" prefetch={false} className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Live Job Search
                </Link>
              </li>
              <li>
                <Link href="/worldwide" prefetch={false} className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Companies Hiring Worldwide
                </Link>
              </li>
              <li>
                <Link href="/login" className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Member Sign In
                </Link>
              </li>
            </ul>
          </div>

          {/* Links Column with Support, Privacy, Terms, Socials */}
          <div className="sm:col-span-1 lg:col-span-3 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">Links</h2>
            <ul className="space-y-1 text-sm text-slate-400">
              <li>
                <a href="mailto:support@careermonke.com" className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Support
                </a>
              </li>
              <li>
                <Link href="/privacy-policy" prefetch={false} className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms-and-conditions" prefetch={false} className="inline-flex items-center py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors">
                  Terms & Conditions
                </Link>
              </li>
              <li className="pt-2 flex flex-wrap items-center gap-2 text-slate-400 text-xs sm:text-sm">
                <a
                  href="https://x.com/careermonke"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Twitter / X"
                  className="inline-flex items-center px-2 py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors"
                >
                  X (Twitter)
                </a>
                <span>•</span>
                <a
                  href="https://linkedin.com/company/careermonke"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="LinkedIn"
                  className="inline-flex items-center px-2 py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors"
                >
                  LinkedIn
                </a>
                <span>•</span>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub"
                  className="inline-flex items-center px-2 py-2 sm:py-1 min-h-[44px] sm:min-h-0 hover:text-white transition-colors"
                >
                  GitHub
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom row: copyright */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400 gap-4 text-center sm:text-left">
          <p>© {new Date().getFullYear()} CareerMonke Inc. All rights reserved.</p>
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
            <Link href="/privacy-policy" className="inline-flex items-center min-h-[44px] sm:min-h-0 py-2 sm:py-0 hover:text-slate-300 transition-colors">
              Privacy
            </Link>
            <Link href="/terms-and-conditions" className="inline-flex items-center min-h-[44px] sm:min-h-0 py-2 sm:py-0 hover:text-slate-300 transition-colors">
              Terms
            </Link>
            <Link href="/worldwide" className="inline-flex items-center min-h-[44px] sm:min-h-0 py-2 sm:py-0 hover:text-slate-300 transition-colors">
              Worldwide Directory
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
