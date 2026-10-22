import React from "react";
import Link from "next/link";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { GUIDE_ARTICLES } from "@/data/guides/articles";
import { CATEGORY_LANDINGS } from "@/data/guides/categories";
import { BookOpen, ArrowRight, ShieldCheck, Compass, Briefcase, FileText } from "lucide-react";

export const metadata = {
  title: "Career Resources & Hiring Guides | CareerMonke",
  description: "Explore in-depth analysis on direct ATS hiring, salary benchmarks, and remote job search strategies.",
};

export default function ResourcesIndexPage() {
  const articles = Object.values(GUIDE_ARTICLES);
  const categories = Object.values(CATEGORY_LANDINGS);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-12 sm:py-16 space-y-12">
        {/* Hero Banner */}
        <div className="text-center max-w-2xl mx-auto space-y-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 border border-blue-200 px-3 py-1 rounded-full">
            Knowledge Hub
          </span>
          <h1 className="text-[18px] font-bold uppercase tracking-wider text-[#0F172A]">
            CareerMonke Guides & Resources
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
            Data-backed breakdowns of direct ATS application strategies, compensation benchmarks, and hiring trends.
          </p>
        </div>

        {/* Featured Deep-Dives */}
        <section className="space-y-4">
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-blue-600" />
            <span>Strategic Job Search Guides</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {articles.map((art) => (
              <div
                key={art.slug}
                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-2xs hover:shadow-md transition flex flex-col justify-between space-y-4 group"
              >
                <div className="space-y-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600">
                    {art.label}
                  </span>
                  <h3 className="font-bold text-base text-slate-900 group-hover:text-blue-600 transition-colors">
                    {art.title}
                  </h3>
                  <p className="text-xs text-slate-600 line-clamp-3 leading-relaxed">
                    {art.lede}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">{art.updatedDate}</span>
                  <Link
                    href={`/remote/${art.slug}`}
                    className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Read Guide</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Category Landing Portals */}
        <section className="space-y-4">
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 flex items-center gap-2">
            <Compass className="w-5 h-5 text-blue-600" />
            <span>Niche Role Portals</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {categories.map((cat) => (
              <Link
                key={cat.slug}
                href={`/remote/jobs/${cat.slug}`}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs hover:border-blue-300 hover:shadow-xs transition flex flex-col justify-between space-y-3 group"
              >
                <div>
                  <h3 className="font-bold text-sm text-slate-900 group-hover:text-blue-600 transition">
                    {cat.title}
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    {cat.lede}
                  </p>
                </div>
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs font-bold text-blue-600 group-hover:text-blue-700">
                  <span>Explore Roles</span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Global Directory Link */}
        <section className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-2xl border border-blue-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="font-bold text-base text-slate-900">Explore Verified Companies Hiring Worldwide</h3>
            <p className="text-xs text-slate-600">
              Verified distributed organizations with open job feeds.
            </p>
          </div>
          <Link
            href="/worldwide"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-xs shadow-xs hover:bg-blue-700 transition shrink-0 self-start sm:self-auto"
          >
            <span>View Companies Directory</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </section>
      </main>

      <Footer />
    </div>
  );
}
