import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { CmpTable } from "@/components/CmpTable";
import { FaqGuidesItem } from "@/components/FaqItems";
import { GUIDE_ARTICLES } from "@/data/guides/articles";
import { Check, AlertCircle, ArrowRight, ChevronRight } from "lucide-react";

interface PageProps {
  params: {
    slug: string;
  };
}

export const runtime = process.env.CF_PAGES === "1" ? "edge" : "nodejs";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(GUIDE_ARTICLES).map((slug) => ({
    slug,
  }));
}

export function generateMetadata({ params }: PageProps) {
  const article = GUIDE_ARTICLES[params.slug];
  if (!article) return { title: "Guide Not Found" };

  return {
    title: `${article.title} | CareerMonke Guides`,
    description: article.lede,
  };
}

export default function GuideArticlePage({ params }: PageProps) {
  const article = GUIDE_ARTICLES[params.slug];

  if (!article) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-white text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1">
        {/* ========================================================================= */}
        {/* 1. HERO WITH BREADCRUMBS & BLUE DOT GRID                                  */}
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
            {/* Breadcrumbs (0.8rem white) */}
            <nav className="flex items-center gap-2 text-[0.8rem] text-white/80 font-medium">
              <Link href="/" className="hover:text-white transition-colors">
                Home
              </Link>
              <ChevronRight className="w-3.5 h-3.5" />
              <Link href="/remote" className="hover:text-white transition-colors">
                Guides
              </Link>
              <ChevronRight className="w-3.5 h-3.5" />
              <span className="text-white truncate max-w-[200px] sm:max-w-none">
                {article.title}
              </span>
            </nav>

            {/* Eyebrow Label */}
            <div className="text-[0.78rem] font-semibold tracking-[0.14em] uppercase text-blue-200 flex items-center gap-2">
              <span className="w-6 h-px bg-blue-300" />
              <span>{article.label}</span>
            </div>

            {/* Guide H1: clamp(2.1rem, 5vw, 3rem), bold, white, left-aligned */}
            <h1 className="text-[clamp(2.1rem,5vw,3rem)] font-bold text-white left-aligned leading-[1.12] max-w-4xl tracking-tight">
              {article.title}
            </h1>

            {/* Lede: 1.125rem, line-height 1.44, weight 500, max-width 62ch */}
            <p className="text-[1.125rem] leading-[1.44] font-medium text-white/90 max-w-[62ch]">
              {article.lede}
            </p>

            {/* Anchor scroll buttons */}
            <div className="pt-2 flex flex-wrap items-center gap-4">
              <a
                href="#verdict"
                className="inline-flex items-center justify-center bg-white text-[#09090B] font-semibold text-sm sm:text-base px-6 py-3 rounded-[6px] shadow-sm hover:bg-gray-100 transition-colors"
              >
                Read the verdict
              </a>
              <a
                href="#comparison"
                className="inline-flex items-center justify-center bg-transparent border border-white/50 text-white font-medium text-sm sm:text-base px-6 py-3 rounded-[6px] hover:bg-white/10 transition-colors"
              >
                Compare the models
              </a>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* ARTICLE BODY & VERDICT BOX                                                */}
        {/* ========================================================================= */}
        <div className="max-w-content mx-auto px-6 py-12 sm:py-16">
          {/* ======================================================================= */}
          {/* VERDICT BOX (Navy #090E34, radius 12px)                                 */}
          {/* ======================================================================= */}
          <section id="verdict" className="bg-[#090E34] text-white rounded-[12px] p-7 sm:p-10 shadow-lg border border-slate-800 mb-16">
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-400 bg-blue-900/50 px-2.5 py-1 rounded">
                  {article.verdict.label}
                </span>
                <span className="text-xs text-slate-400">• {article.updatedDate}</span>
              </div>

              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                {article.verdict.title}
              </h2>

              <p className="text-slate-300 text-base leading-relaxed max-w-3xl">
                {article.verdict.description}
              </p>

              {/* Two mini columns: Start here / Add X when */}
              <div className="pt-4 border-t border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-900/60 rounded-lg p-5 border border-slate-800 space-y-3">
                  <h4 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                    <Check className="w-4 h-4" />
                    <span>{article.verdict.startHere.title}</span>
                  </h4>
                  <ul className="space-y-2 text-xs sm:text-sm text-slate-300">
                    {article.verdict.startHere.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-emerald-400">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-slate-900/60 rounded-lg p-5 border border-slate-800 space-y-3">
                  <h4 className="text-sm font-bold text-amber-400 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    <span>{article.verdict.addWhen.title}</span>
                  </h4>
                  <ul className="space-y-2 text-xs sm:text-sm text-slate-300">
                    {article.verdict.addWhen.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-amber-400">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Source Note */}
              <div className="pt-2 text-xs text-slate-400 italic">
                {article.verdict.sourceNote}
              </div>
            </div>
          </section>

          {/* Feature Grid: 4 blocks */}
          <div className="mb-16">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-6">
              Key Structural Highlights
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {article.features.map((feat, i) => (
                <div
                  key={i}
                  className="bg-white border border-[#E4E4E7] rounded-lg p-5 shadow-sm space-y-2"
                >
                  <h4 className="text-base font-bold text-[#09090B]">{feat.title}</h4>
                  <p className="text-xs text-[#4B5563] leading-relaxed">
                    {feat.description}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Long-form Content Sections */}
          <div className="max-w-[760px] mx-auto space-y-12">
            {article.sections.map((sec) => (
              <section key={sec.id} id={sec.id} className="space-y-4">
                {/* Guide H2: clamp(1.5rem, 3vw, 2.25rem), line-height 1.111, letter-spacing -0.025em, margin-top 3rem */}
                <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em] mt-12 mb-4">
                  {sec.h2}
                </h2>
                {sec.paragraphs.map((p, idx) => (
                  <p
                    key={idx}
                    className="text-[rgb(99,115,129)] text-base sm:text-lg leading-relaxed"
                  >
                    {p}
                  </p>
                ))}
                {sec.quote && (
                  <blockquote className="border-l-4 border-blue-600 pl-4 py-2 my-6 text-lg font-medium text-[#09090B] italic bg-blue-50/40 rounded-r-lg">
                    &ldquo;{sec.quote}&rdquo;
                  </blockquote>
                )}
              </section>
            ))}

            {/* Comparison Table Section */}
            <section id="comparison" className="pt-8">
              <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em] mb-4">
                {article.comparisonTable.title}
              </h2>
              <p className="text-[rgb(99,115,129)] text-base mb-4">
                Side-by-side performance indicators between automated crawling pipelines and legacy aggregation portals.
              </p>
              <CmpTable
                headers={article.comparisonTable.headers}
                rows={article.comparisonTable.rows}
              />
            </section>

            {/* FAQ Accordion (details style) */}
            <section className="pt-12 border-t border-[#E4E4E7] space-y-6">
              <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] font-bold text-[#142033] leading-[1.111] tracking-[-0.025em]">
                Frequently Asked Inquiries
              </h2>
              <div className="divide-y divide-[#E4E4E7]">
                {article.faqs.map((faq, i) => (
                  <FaqGuidesItem
                    key={i}
                    question={faq.question}
                    answer={faq.answer}
                    defaultOpen={i === 0}
                  />
                ))}
              </div>
            </section>

            {/* Final CTA Block at the end */}
            <div className="mt-16 bg-[#F8FAFF] rounded-2xl p-8 sm:p-10 border border-[#DBE3EF] text-center space-y-4">
              <h3 className="text-2xl font-bold text-[#09090B]">
                Start Discovering Unindexed Roles Now
              </h3>
              <p className="text-[#4B5563] text-sm sm:text-base max-w-lg mx-auto">
                Explore real-time telemetry from thousands of employer career endpoints across software, design, data, and infrastructure.
              </p>
              <div className="pt-2">
                <Link
                  href="/job-search/all"
                  className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold px-7 py-3 rounded-md text-sm transition-colors shadow-sm"
                >
                  <span>Explore 61,000+ Verified Jobs</span>
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
