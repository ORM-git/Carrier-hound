import React from "react";
import Link from "next/link";
import BrandIcon from "./BrandIcon";
import { cnTokens } from "@/components/ui/cn-tokens";

interface FooterProps {
  isGuide?: boolean;
}

/* Token-driven link style (Redesign PART 1). 44px touch target on mobile. */
const footerLinkClass =
  "inline-flex items-center min-h-[44px] sm:min-h-[32px] text-tk-body-sm text-ink-muted hover:text-brand-700 transition-colors duration-tk-fast";

const bottomLinkClass = cnTokens(footerLinkClass, "sm:min-h-0 text-tk-caption");

const columnHeadingClass = "text-tk-caption font-bold uppercase tracking-wider text-ink";

export default function Footer({ isGuide = false }: FooterProps) {
  return (
    <footer className="relative bg-surface-subtle text-ink border-t border-line pt-tk-6 pb-24 sm:pb-tk-4">
      <div className="max-w-content mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-tk-4 pb-tk-4 border-b border-line">
          {/* Brand + Tagline */}
          <div className="lg:col-span-4 space-y-tk-2">
            <Link href="/" className="inline-flex items-center gap-2.5 min-h-[44px] rounded-tk-lg">
              <div className="w-9 h-9 rounded-tk-full bg-surface flex items-center justify-center p-1 shadow-tk-xs border border-line overflow-hidden">
                <BrandIcon className="w-7 h-7" />
              </div>
              <span className="text-xl font-black tracking-tight text-brand-600">CareerMonke</span>
            </Link>
            <p className="text-tk-body-sm text-ink-muted max-w-sm">
              We find jobs posted on company websites. Real-time radar for unindexed remote engineering, design, data, and product jobs directly from verified company ATS endpoints.
            </p>
          </div>

          {/* 3-column link layout */}
          <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-3 gap-tk-3">
            {/* Quick Links Column */}
            <div className="space-y-tk-1">
              <h2 className={columnHeadingClass}>Navigation</h2>
              <ul className="space-y-0.5">
                <li>
                  <Link href="/job-search/all" prefetch={false} className={footerLinkClass}>
                    Live Job Search
                  </Link>
                </li>
                <li>
                  <Link href="/worldwide" prefetch={false} className={footerLinkClass}>
                    Companies Hiring Worldwide
                  </Link>
                </li>
                <li>
                  <Link href="/pricing" prefetch={false} className={footerLinkClass}>
                    Pricing & Plans
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={footerLinkClass}>
                    Member Sign In
                  </Link>
                </li>
              </ul>
            </div>

            {/* Links Column with Support, Privacy, Terms */}
            <div className="space-y-tk-1">
              <h2 className={columnHeadingClass}>Links</h2>
              <ul className="space-y-0.5">
                <li>
                  <a href="mailto:support@careermonke.com" className={footerLinkClass}>
                    Support
                  </a>
                </li>
                <li>
                  <Link href="/privacy-policy" prefetch={false} className={footerLinkClass}>
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms-and-conditions" prefetch={false} className={footerLinkClass}>
                    Terms & Conditions
                  </Link>
                </li>
              </ul>
            </div>

            {/* Socials Column */}
            <div className="space-y-tk-1">
              <h2 className={columnHeadingClass}>Social</h2>
              <ul className="space-y-0.5">
                <li>
                  <a
                    href="https://x.com/careermonke"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Twitter / X"
                    className={footerLinkClass}
                  >
                    X (Twitter)
                  </a>
                </li>
                <li>
                  <a
                    href="https://linkedin.com/company/careermonke"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="LinkedIn"
                    className={footerLinkClass}
                  >
                    LinkedIn
                  </a>
                </li>
                <li>
                  <a
                    href="https://github.com"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="GitHub"
                    className={footerLinkClass}
                  >
                    GitHub
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom row: copyright */}
        <div className="pt-tk-3 flex flex-col sm:flex-row items-center justify-between gap-tk-2 text-center sm:text-left">
          <p className="text-tk-caption text-ink-subtle">© {new Date().getFullYear()} CareerMonke Inc. All rights reserved.</p>
          <div className="flex flex-wrap items-center justify-center gap-x-tk-3">
            <Link href="/privacy-policy" className={bottomLinkClass}>
              Privacy
            </Link>
            <Link href="/terms-and-conditions" className={bottomLinkClass}>
              Terms
            </Link>
            <Link href="/worldwide" className={bottomLinkClass}>
              Worldwide Directory
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
