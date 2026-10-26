import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import JobPreview from "@/components/JobPreview";
import Chip from "@/components/Chip";
import { FaqGuidesItem } from "@/components/FaqItems";
import { CATEGORY_LANDINGS } from "@/data/guides/categories";
import { ChevronRight, ArrowRight, ShieldCheck } from "lucide-react";

interface PageProps {
  params: {
    category: string;
  };
}

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(CATEGORY_LANDINGS).map((category) => ({
    category,
  }));
}

export function generateMetadata({ params }: PageProps) {
  const data = CATEGORY_LANDINGS[params.category];
  if (!data) return { title: "Category Landing Not Found" };

  return {
    title: `${data.title} | CareerMonke Jobs`,
    description: data.lede,
  };
}

export default function CategoryLandingPage({ params }: PageProps) {
  const data = CATEGORY_LANDINGS[params.category];

  if (!data) {
    notFound();
  }

  // Live category jobs (empty state when offline or unpopulated)
  const sampleJobs: any[] = [];

  return (
    <div className="min-h-screen bg-white text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1">
        {/* ========================================================================= */}
        {/* 1. HERO SECTION                                                           */}
        {/* ========================================================================= */}
        <section
          className="relative bg-[#2563EB] text-white pt-12 pb-20 sm:pb-24 overflow-hidden"
          style={{
            backgroundImage:
              "radial-gradient(circle at 2px 2px, #ffffff 1px, transparent 0)",
            backgroundSize: "32px 32px",
          }}
        >
          <div className="absolute inset-0 bg-[#2563EB] -z-10" />

          <div className="max-w-content mx-auto px-4 sm:px-6 relative z-10 space-y-5">
            {/* Breadcrumbs */}
            <nav className="flex items-center gap-2 text-[0.8rem] text-white/80 font-medium overflow-x-auto no-scrollbar">
              <Link href="/" className="hover:text-white transition-colors shrink-0">
                Home
              </Link>
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              <Link href="/remote" className="hover:text-white transition-colors shrink-0">
                Guides
              </Link>
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              <span className="text-white truncate">{data.name}</span>
            </nav>

            {/* Eyebrow with leading line */}
            <div className="text-[0.78rem] font-semibold tracking-[0.14em] uppercase text-blue-200 flex items-center gap-2">
              <span className="w-6 h-px bg-blue-300" />
              <span>{data.eyebrow}</span>
            </div>

            {/* 2-line H1 */}
            <h1 className="text-[clamp(1.75rem,5vw,3rem)] font-bold text-white left-aligned leading-[1.12] max-w-4xl tracking-tight">
              {data.title}
            </h1>

            {/* Lede */}
            <p className="text-base sm:text-[1.125rem] leading-[1.44] font-medium text-white/90 max-w-[62ch]">
              {data.lede}
            </p>

            {/* Action buttons: white "See sample jobs" + ghost "Search every title" */}
            <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4 w-full sm:w-auto">
              <a
                href="#sample-jobs"
                className="w-full sm:w-auto inline-flex items-center justify-center bg-white text-[#09090B] font-semibold text-base px-6 py-3 min-h-[48px] rounded-lg shadow-sm hover:bg-gray-100 transition-colors"
              >
                See sample jobs
              </a>
              <Link
                href={`/job-search/all?categories=${data.slug}`}
                className="w-full sm:w-auto inline-flex items-center justify-center bg-transparent border border-white/50 text-white font-medium text-base px-6 py-3 min-h-[48px] rounded-lg hover:bg-white/10 transition-colors"
              >
                Search every title
              </Link>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 2. PROOF STRIP (top and bottom borders; left heading, right 2x2 grid)     */}
        {/* ========================================================================= */}
        <section className="border-y border-[#E4E4E7] bg-gray-50/70 py-8">
          <div className="max-w-content mx-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              {/* Left side: bold heading + small gray text */}
              <div className="lg:col-span-5 space-y-2">
                <div className="flex items-center gap-2 text-emerald-700 font-semibold text-xs tracking-wider uppercase">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Verified Telemetry</span>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                  {data.proofStrip.heading}
                </h3>
                <p className="text-sm text-[#4B5563] leading-relaxed">
                  {data.proofStrip.subheading}
                </p>
              </div>

              {/* Right side: 2x2 grid of label/value pairs with dividers */}
              <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                {data.proofStrip.metrics.map((metric, i) => (
                  <div key={i} className={`space-y-1 ${i > 0 ? "sm:pl-4" : ""} pt-2 sm:pt-0`}>
                    <div className="text-xs text-[#4B5563] uppercase tracking-wider font-semibold">
                      {metric.label}
                    </div>
                    <div className="text-2xl font-black text-[#09090B]">
                      {metric.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 3. FRESH OPENINGS & JOB PREVIEW COMPONENT                                 */}
        {/* ========================================================================= */}
        <section id="sample-jobs" className="py-16 max-w-content mx-auto px-6 space-y-6">
          <div className="space-y-2">
            <h2 className="text-2xl sm:text-3xl font-bold text-[#142033] tracking-tight">
              {data.openingsCount}
            </h2>
            <p className="text-[#4B5563] text-base max-w-2xl">
              {data.openingsDescription}
            </p>
          </div>

          {/* Job Preview Component */}
          <JobPreview
            title={`Real-Time ${data.name} Feed`}
            subtitle="Scraped from employer subdomains within the last 4 hours"
            jobs={sampleJobs}
            limit={5}
          />

          <div className="text-center pt-2">
            <Link
              href={`/job-search/all?categories=${data.slug}`}
              className="inline-flex items-center gap-2 bg-black hover:bg-neutral-800 text-white font-semibold px-7 py-3.5 min-h-[44px] rounded-lg text-sm transition-colors shadow-sm"
            >
              <span>Explore All {data.name} Roles on Radar</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 4. SEARCH THE COMPLETE TITLE FAMILY (Chips of title aliases)              */}
        {/* ========================================================================= */}
        <section className="py-12 bg-[#F8FAFF] border-y border-[#DBE3EF]">
          <div className="max-w-content mx-auto px-6 space-y-6">
            <div className="space-y-1">
              <h2 className="text-xl sm:text-2xl font-bold text-[#142033] tracking-tight">
                Search the complete title family
              </h2>
              <p className="text-sm text-[#4B5563]">
                Click any specific title to filter exact openings across employer boards.
              </p>
            </div>

            <div className="flex flex-wrap gap-2.5">
              {data.titleAliases.map((alias, i) => (
                <Link
                  key={i}
                  href={`/job-search/all?search=${encodeURIComponent(alias)}`}
                >
                  <Chip variant="outline" className="bg-white hover:border-blue-500 hover:text-blue-600 transition-colors">
                    {alias}
                  </Chip>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 5. FAQ ACCORDION (Details style)                                          */}
        {/* ========================================================================= */}
        <section className="py-16 max-w-content mx-auto px-6 space-y-6">
          <div className="space-y-2">
            <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em]">
              Frequently Asked Questions About {data.name} Roles
            </h2>
          </div>

          <div className="max-w-[760px] divide-y divide-[#E4E4E7]">
            {data.faqs.map((faq, i) => (
              <FaqGuidesItem
                key={i}
                question={faq.question}
                answer={faq.answer}
                defaultOpen={i === 0}
              />
            ))}
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 6. GO DEEPER BEFORE YOU APPLY: RELATED-GUIDES GRID (2 columns)            */}
        {/* ========================================================================= */}
        <section className="pb-20 max-w-content mx-auto px-6 space-y-6">
          <div className="space-y-1">
            <h2 className="text-xl sm:text-2xl font-bold text-[#142033] tracking-tight">
              Go deeper before you apply
            </h2>
            <p className="text-sm text-[#4B5563]">
              Strategy documents, interview preparation, and compensation negotiation resources.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {data.relatedGuides.map((guide, i) => (
              <Link
                key={i}
                href={guide.href}
                className="bg-white border border-[#E4E4E7] rounded-xl p-6 hover:shadow-md hover:border-blue-300 transition-all flex flex-col justify-between group"
              >
                <div className="space-y-2 mb-4">
                  <h3 className="text-lg font-bold text-[#09090B] group-hover:text-blue-600 transition-colors">
                    {guide.title}
                  </h3>
                  <p className="text-sm text-[#4B5563] leading-relaxed">
                    {guide.description}
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 group-hover:translate-x-1 transition-transform">
                  <span>Read full guide</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <Footer isGuide={true} />
    </div>
  );
}
