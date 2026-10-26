import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import JobPreview from "@/components/JobPreview";
import { FaqGuidesItem } from "@/components/FaqItems";
import { ROLE_GUIDES } from "@/data/guides/roles";
import {
  ChevronRight,
  TrendingUp,
  Award,
  Compass,
  Sliders,
  Layers,
  ArrowRight,
} from "lucide-react";

interface PageProps {
  params: {
    slug: string;
  };
}

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ROLE_GUIDES).map((role) => ({
    slug: role,
  }));
}

export function generateMetadata({ params }: PageProps) {
  const guide = ROLE_GUIDES[params.slug];
  if (!guide) return { title: "Role Guide Not Found" };

  return {
    title: `${guide.hero.title} | CareerMonke`,
    description: guide.hero.lede,
  };
}

export default function RoleTitlesPage({ params }: PageProps) {
  const guide = ROLE_GUIDES[params.slug];

  if (!guide) {
    notFound();
  }

  // Live role jobs (empty state when offline or unpopulated)
  const roleJobs: any[] = [];

  return (
    <div className="min-h-screen bg-white text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1">
        {/* ========================================================================= */}
        {/* HERO WITH BREADCRUMBS                                                     */}
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

          <div className="max-w-content mx-auto px-6 relative z-10 space-y-5">
            {/* Breadcrumbs */}
            <nav className="flex items-center gap-2 text-[0.8rem] text-white/80 font-medium">
              <Link href="/" className="hover:text-white transition-colors">
                Home
              </Link>
              <ChevronRight className="w-3.5 h-3.5" />
              <Link href="/remote" className="hover:text-white transition-colors">
                Guides
              </Link>
              <ChevronRight className="w-3.5 h-3.5" />
              <span className="text-white truncate">{guide.roleName} Titles</span>
            </nav>

            <div className="text-[0.78rem] font-semibold tracking-[0.14em] uppercase text-blue-200 flex items-center gap-2">
              <span className="w-6 h-px bg-blue-300" />
              <span>{guide.hero.eyebrow}</span>
            </div>

            <h1 className="text-[clamp(2.1rem,5vw,3rem)] font-bold text-white left-aligned leading-[1.12] max-w-4xl tracking-tight">
              {guide.hero.title}
            </h1>

            <p className="text-[1.125rem] leading-[1.44] font-medium text-white/90 max-w-[62ch]">
              {guide.hero.lede}
            </p>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* BODY SECTIONS                                                            */}
        {/* ========================================================================= */}
        <div className="max-w-content mx-auto px-6 py-12 sm:py-16 space-y-16">
          {/* Overview Section */}
          <section className="max-w-[760px]">
            <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em] mb-4">
              {guide.overview.h2}
            </h2>
            <p className="text-[rgb(99,115,129)] text-base sm:text-lg leading-relaxed">
              {guide.overview.text}
            </p>
          </section>

          {/* ======================================================================= */}
          {/* 1. CAREER LADDER / RUNG DIAGRAM (CSS-only Visual Component)             */}
          {/* ======================================================================= */}
          <section className="space-y-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-blue-600" />
              <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                Seniority Ladder & Level Progression
              </h3>
            </div>
            <p className="text-[#4B5563] text-sm sm:text-base max-w-2xl">
              How tier 1 remote tech companies structure responsibility, technical expectations, and salary bands across levels.
            </p>

            <div className="relative border-l-2 border-blue-500 pl-6 sm:pl-8 space-y-8 ml-3 sm:ml-4 my-8">
              {guide.ladder.map((rung, idx) => (
                <div key={idx} className="relative group">
                  {/* Rung node dot on ladder */}
                  <div className="absolute -left-[31px] sm:-left-[39px] top-1.5 w-5 h-5 rounded-full bg-white border-4 border-blue-600 group-hover:scale-125 transition-transform" />

                  <div className="bg-white border border-[#E4E4E7] rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-100 pb-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold uppercase tracking-wider bg-blue-100 text-blue-800 px-2.5 py-1 rounded">
                          {rung.level}
                        </span>
                        <span className="text-xs text-gray-500 font-mono">
                          Exp: {rung.yoe}
                        </span>
                      </div>
                      <span className="text-sm font-bold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
                        {rung.salaryBand}
                      </span>
                    </div>

                    <div>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {rung.titles.map((t, i) => (
                          <span
                            key={i}
                            className="text-xs font-semibold text-[#09090B] bg-gray-100 px-2.5 py-1 rounded-md"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                      <p className="text-sm text-[#4B5563] leading-relaxed">
                        {rung.scope}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ======================================================================= */}
          {/* EMBEDDED JOB-PREVIEW BLOCK (Same component as in Page 9)                 */}
          {/* ======================================================================= */}
          <section className="space-y-4">
            <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
              Live {guide.roleName} ATS Snapshot
            </h3>
            <p className="text-[#4B5563] text-sm">
              Recent openings captured directly from employer applicant tracking systems before public syndication.
            </p>
            {roleJobs && roleJobs.length > 0 && (
              <JobPreview
                title={`Live ${guide.roleName} Openings`}
                subtitle="Crawled directly from employer ATS endpoints every 15 minutes"
                jobs={roleJobs}
                limit={4}
              />
            )}
          </section>

          {/* ======================================================================= */}
          {/* 2. TITLE BANDS (CSS Cards with equivalents & compensation)               */}
          {/* ======================================================================= */}
          <section className="space-y-6">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-600" />
              <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                Title Nomenclature Bands & Equivalents
              </h3>
            </div>
            <p className="text-[#4B5563] text-sm max-w-2xl">
              Nomenclature nuances across startup, scaleup, and global enterprise environments.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {guide.titleBands.map((band, idx) => (
                <div
                  key={idx}
                  className="bg-white border border-[#E4E4E7] rounded-xl p-6 shadow-sm space-y-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-lg font-bold text-[#09090B]">{band.title}</h4>
                    <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full whitespace-nowrap">
                      {band.remoteAvailability}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-xs text-gray-400 uppercase font-semibold">Common Equivalents:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {band.commonEquivalents.map((eq, i) => (
                        <span key={i} className="text-xs bg-gray-50 border border-gray-200 px-2 py-0.5 rounded text-gray-700">
                          {eq}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-gray-100 flex items-center justify-between text-sm">
                    <span className="text-gray-500">Median Realized Comp:</span>
                    <span className="font-bold text-[#09090B] text-base">{band.medianComp}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ======================================================================= */}
          {/* 3. CERTIFICATION ROUTE MAP (CSS Timeline / Route Visual)                 */}
          {/* ======================================================================= */}
          <section className="space-y-6">
            <div className="flex items-center gap-2">
              <Award className="w-5 h-5 text-blue-600" />
              <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                Certification Route Map & Credential Weight
              </h3>
            </div>
            <p className="text-[#4B5563] text-sm max-w-2xl">
              Recruiter screening value versus investment time for recognized industry credentials.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {guide.certRoutes.map((cert, idx) => (
                <div
                  key={idx}
                  className="bg-white border border-[#E4E4E7] rounded-xl p-6 shadow-sm flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                        ROUTE 0{idx + 1}
                      </span>
                      <span className="text-xs font-mono text-gray-400">
                        {cert.estimatedStudyTime}
                      </span>
                    </div>
                    <h4 className="text-base font-bold text-[#09090B] leading-snug">
                      {cert.certName}
                    </h4>
                    <p className="text-xs text-gray-500">{cert.issuer}</p>
                    <p className="text-xs text-[#4B5563] leading-relaxed pt-1">
                      {cert.relevance}
                    </p>
                  </div>

                  {/* Impact score bar */}
                  <div className="pt-2 border-t border-gray-100 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">Recruiter Screen Weight:</span>
                      <span className="font-bold text-blue-600">{cert.impactScore}/100</span>
                    </div>
                    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-600 rounded-full"
                        style={{ width: `${cert.impactScore}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ======================================================================= */}
          {/* 4. ELIGIBILITY COMPASS (2x2 Quadrant Grid Visual)                       */}
          {/* ======================================================================= */}
          <section className="space-y-6">
            <div className="flex items-center gap-2">
              <Compass className="w-5 h-5 text-blue-600" />
              <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                {guide.eligibilityCompass.title}
              </h3>
            </div>
            <p className="text-[#4B5563] text-sm max-w-2xl">
              Where your profile sits within the global hiring ecosystem and what each archetype demands.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-[#F8FAFF] p-6 sm:p-8 rounded-2xl border border-[#DBE3EF]">
              {guide.eligibilityCompass.quadrants.map((quad, idx) => (
                <div
                  key={idx}
                  className="bg-white border border-[#E4E4E7] rounded-xl p-5 shadow-sm space-y-3"
                >
                  <h4 className="text-base font-bold text-[#09090B] flex items-center justify-between">
                    <span>{quad.title}</span>
                    <span className="text-xs font-mono text-blue-600">Q{idx + 1}</span>
                  </h4>
                  <p className="text-xs text-[#4B5563] leading-relaxed">
                    {quad.description}
                  </p>
                  <ul className="space-y-1.5 pt-2 border-t border-gray-100">
                    {quad.requirements.map((req, rIdx) => (
                      <li key={rIdx} className="text-xs text-gray-700 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                        <span>{req}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {/* ======================================================================= */}
          {/* 5. FIT METERS (Track Bars with percentages)                             */}
          {/* ======================================================================= */}
          <section className="space-y-6">
            <div className="flex items-center gap-2">
              <Sliders className="w-5 h-5 text-blue-600" />
              <h3 className="text-xl sm:text-2xl font-bold text-[#09090B]">
                Core Competency Fit Meters
              </h3>
            </div>
            <p className="text-[#4B5563] text-sm max-w-2xl">
              Baseline skill weighting required for top-quartile compensation bracket considerations.
            </p>

            <div className="bg-white border border-[#E4E4E7] rounded-xl p-6 sm:p-8 shadow-sm space-y-6">
              {guide.fitMeters.map((meter, idx) => (
                <div key={idx} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-bold text-[#09090B]">{meter.label}</span>
                    <span className="font-mono font-bold text-blue-600">{meter.percentage}%</span>
                  </div>
                  <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 rounded-full transition-all duration-500"
                      style={{ width: `${meter.percentage}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500">{meter.description}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ======================================================================= */}
          {/* FAQs & FINAL CTA                                                         */}
          {/* ======================================================================= */}
          <section className="pt-8 border-t border-[#E4E4E7] space-y-6 max-w-[760px]">
            <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em]">
              Role Ladder FAQs
            </h2>
            <div className="divide-y divide-[#E4E4E7]">
              {guide.faqs.map((faq, i) => (
                <FaqGuidesItem
                  key={i}
                  question={faq.question}
                  answer={faq.answer}
                  defaultOpen={i === 0}
                />
              ))}
            </div>
          </section>

          {/* CTA Banner */}
          <div className="bg-[#2563EB] text-white rounded-2xl p-8 sm:p-12 text-center relative overflow-hidden shadow-lg">
            <div className="max-w-2xl mx-auto space-y-5 relative z-10">
              <h2 className="text-2xl sm:text-4xl font-bold tracking-tight">
                Ready to find verified {guide.roleName} positions?
              </h2>
              <p className="text-white/90 text-sm sm:text-base leading-relaxed">
                Skip 500-applicant queues on public boards. Access unindexed direct employer ATS feeds right now.
              </p>
              <div className="pt-2">
                <Link
                  href={`/job-search/all?categories=${guide.sampleJobCategory}`}
                  className="inline-flex items-center gap-2 bg-white text-[#09090B] font-semibold px-8 py-3.5 rounded-[6px] shadow-sm hover:bg-gray-100 transition-colors"
                >
                  <span>View All Open {guide.roleName} Roles</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>

      <Footer isGuide={true} />
    </div>
  );
}
