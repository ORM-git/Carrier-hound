"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import BrandIcon from "./BrandIcon";
import { cnTokens } from "@/components/ui/cn-tokens";

interface FooterProps {
  isGuide?: boolean;
}

/* Original landing footer preserved when rendered on the landing page (/) */
const landingFooterLinkClass =
  "inline-flex items-center min-h-[44px] sm:min-h-[32px] text-tk-body-sm text-ink-muted hover:text-brand-700 transition-colors duration-tk-fast";
const landingBottomLinkClass = cnTokens(landingFooterLinkClass, "sm:min-h-0 text-tk-caption");
const landingColumnHeadingClass = "text-tk-caption font-bold uppercase tracking-wider text-ink";

function LandingFooter() {
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
              <h2 className={landingColumnHeadingClass}>Navigation</h2>
              <ul className="space-y-0.5">
                <li>
                  <Link href="/job-search/all" prefetch={false} className={landingFooterLinkClass}>
                    Live Job Search
                  </Link>
                </li>
                <li>
                  <Link href="/worldwide" prefetch={false} className={landingFooterLinkClass}>
                    Companies Hiring Worldwide
                  </Link>
                </li>
                <li>
                  <Link href="/pricing" prefetch={false} className={landingFooterLinkClass}>
                    Pricing & Plans
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={landingFooterLinkClass}>
                    Member Sign In
                  </Link>
                </li>
              </ul>
            </div>

            {/* Links Column with Support, Privacy, Terms */}
            <div className="space-y-tk-1">
              <h2 className={landingColumnHeadingClass}>Links</h2>
              <ul className="space-y-0.5">
                <li>
                  <a href="mailto:support@careermonke.com" className={landingFooterLinkClass}>
                    Support
                  </a>
                </li>
                <li>
                  <Link href="/privacy-policy" prefetch={false} className={landingFooterLinkClass}>
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms-and-conditions" prefetch={false} className={landingFooterLinkClass}>
                    Terms & Conditions
                  </Link>
                </li>
              </ul>
            </div>

            {/* Socials Column */}
            <div className="space-y-tk-1">
              <h2 className={landingColumnHeadingClass}>Social</h2>
              <ul className="space-y-0.5">
                <li>
                  <a
                    href="https://x.com/careermonke"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Twitter / X"
                    className={landingFooterLinkClass}
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
                    className={landingFooterLinkClass}
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
                    className={landingFooterLinkClass}
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
            <Link href="/privacy-policy" className={landingBottomLinkClass}>
              Privacy
            </Link>
            <Link href="/terms-and-conditions" className={landingBottomLinkClass}>
              Terms
            </Link>
            <Link href="/worldwide" className={landingBottomLinkClass}>
              Worldwide Directory
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

/* Prompt 2 Rebuild: Public shell footer for non-landing pages */
const publicFooterLinkClass =
  "inline-flex items-center min-h-[44px] sm:min-h-[28px] text-[14px] text-[#475569] hover:text-[#2563EB] transition-colors duration-200";

export default function Footer({ isGuide = false }: FooterProps) {
  const pathname = usePathname();

  // Landing page (/) must look exactly as it does now
  if (pathname === "/") {
    return <LandingFooter />;
  }

  return (
    <footer className="w-full bg-white text-[#0F172A] border-t border-[#E2E8F0] pt-12 pb-24 sm:pb-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        {/* 4-column links block: existing links only, no support email, no fake social icons */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Column 1: Jobs & Discovery */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#0F172A]">
              Discovery
            </h3>
            <ul className="space-y-2">
              <li>
                <Link href="/jobs" prefetch={false} className={publicFooterLinkClass}>
                  Live Job Search
                </Link>
              </li>
              <li>
                <Link href="/worldwide" prefetch={false} className={publicFooterLinkClass}>
                  Worldwide Remote
                </Link>
              </li>
              <li>
                <Link href="/radar" prefetch={false} className={publicFooterLinkClass}>
                  3D Job Radar
                </Link>
              </li>
              <li>
                <Link href="/remote" prefetch={false} className={publicFooterLinkClass}>
                  Remote Guides
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 2: Tools & AI */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#0F172A]">
              Platform
            </h3>
            <ul className="space-y-2">
              <li>
                <Link href="/resume" prefetch={false} className={publicFooterLinkClass}>
                  ATS Resume Builder
                </Link>
              </li>
              <li>
                <Link href="/tracker" prefetch={false} className={publicFooterLinkClass}>
                  Applications Tracker
                </Link>
              </li>
              <li>
                <Link href="/pricing" prefetch={false} className={publicFooterLinkClass}>
                  Pricing & Plans
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 3: Account */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#0F172A]">
              Account
            </h3>
            <ul className="space-y-2">
              <li>
                <Link href="/login" className={publicFooterLinkClass}>
                  Log In
                </Link>
              </li>
              <li>
                <Link href="/signup" className={publicFooterLinkClass}>
                  Get Started
                </Link>
              </li>
              <li>
                <Link href="/dashboard" className={publicFooterLinkClass}>
                  Candidate Dashboard
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 4: Legal & Policies */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#0F172A]">
              Legal
            </h3>
            <ul className="space-y-2">
              <li>
                <Link href="/privacy-policy" prefetch={false} className={publicFooterLinkClass}>
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms-and-conditions" prefetch={false} className={publicFooterLinkClass}>
                  Terms & Conditions
                </Link>
              </li>
              <li>
                <Link href="/privacy" prefetch={false} className={publicFooterLinkClass}>
                  Cookie Notice
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom row: Brand & Copyright line */}
        <div className="pt-6 border-t border-[#E2E8F0] flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0]">
              <BrandIcon className="w-5 h-5" />
            </div>
            <span className="text-sm font-bold text-[#2563EB] tracking-tight">
              CareerMonke
            </span>
          </div>
          <p className="text-xs text-[#94A3B8]">
            © {new Date().getFullYear()} CareerMonke Inc. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
