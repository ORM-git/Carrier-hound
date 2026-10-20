"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";

interface MegaMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MegaMenu({ isOpen, onClose }: MegaMenuProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-x-0 top-[65px] z-40 px-4 pt-2">
      {/* Backdrop */}
      <div
        className="fixed inset-0 top-[64px] bg-black/25 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />

      {/* Menu container */}
      <div className="relative max-w-content mx-auto bg-white rounded-[14px] shadow-[0_20px_50px_rgba(9,14,52,0.2)] border border-[#E4E4E7] overflow-hidden max-h-[calc(100vh-90px)] overflow-y-auto">
        {/* Top Header line */}
        <div className="bg-gray-50/80 px-6 sm:px-8 py-3.5 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-bold text-[#09090B]">Explore CareerMonke Guides</span>
            <span className="text-gray-400">•</span>
            <span className="text-gray-500 hidden sm:inline">Tactical intel for bypassing public queues</span>
          </div>
          <Link
            href="/remote"
            onClick={onClose}
            className="text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8] flex items-center gap-1 group"
          >
            <span>View all guides</span>
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>

        {/* 3 Columns: 1.1fr / 2fr / 1.1fr */}
        <div className="p-6 sm:p-8 grid grid-cols-1 lg:grid-cols-[1.1fr_2fr_1.1fr] gap-8 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
          {/* Col 1: START HERE */}
          <div className="space-y-4">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">
              Start Here
            </div>
            <div className="space-y-3">
              <Link
                href="/remote/hidden-job-market-guide"
                onClick={onClose}
                className="block p-3 rounded-lg hover:bg-blue-50/50 transition-colors group"
              >
                <div className="font-bold text-[#09090B] text-sm group-hover:text-blue-600 flex items-center justify-between">
                  <span>The Stealth Job Market</span>
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                </div>
                <p className="text-xs text-[#4B5563] mt-1 leading-relaxed">
                  How high-growth tech ventures hire before syndicating to public boards.
                </p>
              </Link>

              <Link
                href="/remote/flexjobs-alternative-review"
                onClick={onClose}
                className="block p-3 rounded-lg hover:bg-blue-50/50 transition-colors group"
              >
                <div className="font-bold text-[#09090B] text-sm group-hover:text-blue-600 flex items-center justify-between">
                  <span>Paid Boards Breakdown</span>
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                </div>
                <p className="text-xs text-[#4B5563] mt-1 leading-relaxed">
                  Comparing closed subscription boards against real-time ATS scrapers.
                </p>
              </Link>

              <Link
                href="/remote/remote-job-search-secrets"
                onClick={onClose}
                className="block p-3 rounded-lg hover:bg-blue-50/50 transition-colors group"
              >
                <div className="font-bold text-[#09090B] text-sm group-hover:text-blue-600 flex items-center justify-between">
                  <span>The Zero-Ghost Protocol</span>
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                </div>
                <p className="text-xs text-[#4B5563] mt-1 leading-relaxed">
                  Spotting ghost listings and expired postings before submitting applications.
                </p>
              </Link>
            </div>
          </div>

          {/* Col 2: ROLE GUIDES (2-column link grid with arrow markers + blue subheading group) */}
          <div className="pt-6 lg:pt-0 lg:px-8 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-wider text-gray-400">
                Role Guides & Ladders
              </div>
              <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                Title Taxonomy
              </span>
            </div>

            {/* 2-column link grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Link
                href="/remote/devops-engineer/titles"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>DevOps & SRE Ladders</span>
              </Link>

              <Link
                href="/remote/product-designer/titles"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>Product Design Titles</span>
              </Link>

              <Link
                href="/remote/jobs/devops"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>Infrastructure Roles</span>
              </Link>

              <Link
                href="/remote/jobs/design"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>Design & UX Feed</span>
              </Link>

              <Link
                href="/remote/jobs/marketing"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>Growth Marketing Feed</span>
              </Link>

              <Link
                href="/remote/jobs/data"
                onClick={onClose}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-gray-50 text-sm text-[#09090B] font-medium group"
              >
                <ArrowRight className="w-3.5 h-3.5 text-blue-600 transition-transform group-hover:translate-x-1" />
                <span>Data Engineering Feed</span>
              </Link>
            </div>

            {/* Blue subheading group */}
            <div className="mt-4 pt-3 border-t border-gray-100 bg-[#F8FAFF] p-3 rounded-lg border border-[#DBE3EF]">
              <h5 className="text-xs font-bold text-[#2563EB] uppercase tracking-wider mb-1">
                Direct ATS Compensation Benchmarks
              </h5>
              <p className="text-xs text-[#4B5563]">
                Access verified salary bands scraped directly from verified employer disclosures.
              </p>
            </div>
          </div>

          {/* Col 3: FOR HOW YOU WORK (rich links) */}
          <div className="pt-6 lg:pt-0 lg:pl-8 space-y-4">
            <div className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">
              For How You Work
            </div>
            <div className="space-y-3">
              <Link
                href="/worldwide"
                onClick={onClose}
                className="block p-3 rounded-lg hover:bg-blue-50/50 transition-colors group"
              >
                <div className="font-bold text-[#09090B] text-sm group-hover:text-blue-600 flex items-center justify-between">
                  <span>Worldwide Hiring</span>
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                </div>
                <p className="text-xs text-[#4B5563] mt-1 leading-relaxed">
                  Verified employers hiring without local residency barriers.
                </p>
              </Link>

              <Link
                href="/job-search/all?remote=true"
                onClick={onClose}
                className="block p-3 rounded-lg hover:bg-blue-50/50 transition-colors group"
              >
                <div className="font-bold text-[#09090B] text-sm group-hover:text-blue-600 flex items-center justify-between">
                  <span>Asynchronous Teams</span>
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                </div>
                <p className="text-xs text-[#4B5563] mt-1 leading-relaxed">
                  Companies prioritizing documentation over synchronous status meetings.
                </p>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
