"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import BrandIcon from "@/components/BrandIcon";
import DotPattern from "@/components/DotPattern";
import AvatarStack from "@/components/AvatarStack";
import ProductScreenshotMock from "@/components/ProductScreenshotMock";
import { FaqHomeItem } from "@/components/FaqItems";
import { WhiteHeroButton } from "@/components/Buttons";
import CategorySelectModal from "@/components/CategorySelectModal";
import Footer from "@/components/Footer";
import GlobeLiveStats from "@/components/GlobeLiveStats";
import { useLiveStats } from "@/lib/api/stats";
import { TestimonialMarqueeDemo } from "@/components/ui/marquee-01";
import { X, Check, ArrowRight } from "lucide-react";

const WireframeDottedGlobe = dynamic(
  () => import("@/components/ui/wireframe-dotted-globe"),
  { ssr: false }
);

const Testimonials = dynamic(
  () => import("@/components/testimonials").then((m) => m.Testimonials),
  { ssr: false }
);

const UserMenu = dynamic(() => import("@/components/UserMenu"), {
  ssr: false,
  loading: () => (
    <Link
      href="/login"
      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg text-sm font-semibold transition-all border border-white/30 text-white hover:bg-white/10"
    >
      <span>Sign In</span>
    </Link>
  ),
});

export default function HomePage() {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const { totalJobs } = useLiveStats();

  // Returning signed-in user visiting / goes to /dashboard (lazy loaded so Supabase isn't critical path)
  useEffect(() => {
    import("@/lib/auth/session").then(({ getAuthUser }) => {
      getAuthUser().then((user) => {
        if (user) {
          router.replace("/dashboard");
        }
      });
    });
  }, [router]);

  return (
    <main className="min-h-screen bg-white text-[#09090B] flex flex-col selection:bg-blue-100 selection:text-blue-900">
      {/* ========================================================================= */}
      {/* 1. HERO SECTION (Blue #2563EB, centered) with overlay header              */}
      {/* ========================================================================= */}
      <section className="relative bg-[#2563EB] text-white pt-6 overflow-hidden">
        {/* Background Subtle Gradient & Dots */}
        <div className="absolute inset-0 pointer-events-none opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:24px_24px]" />

        {/* Minimal Hero Header (no nav bar, sits directly on blue hero) */}
        <div className="w-full max-w-[1340px] mx-auto px-4 sm:px-10 lg:px-14 xl:px-16 pt-4 sm:pt-6 mb-8 sm:mb-14 lg:mb-16 flex items-center justify-between relative z-20">
          {/* Left: Round white logo circle */}
          <Link
            href="/"
            aria-label="CareerMonke Home"
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white flex items-center justify-center shadow-lg transition-transform hover:scale-105 p-1.5 min-h-[44px] min-w-[44px]"
          >
            <BrandIcon className="w-11 h-11 sm:w-12 sm:h-12" />
          </Link>

          {/* Right: Auth-aware Sign In / User Menu */}
          <UserMenu />
        </div>

        {/* Hero Content - centered with 16px rhythm and 32px gap above card panel */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center relative z-20 flex flex-col items-center">
          <h1 className="text-2xl sm:text-4xl md:text-5xl lg:text-[48px] font-bold leading-tight sm:leading-tight text-white max-w-3xl mx-auto tracking-tight">
            Find jobs not on LinkedIn/Indeed
          </h1>

          <p className="mt-4 text-white/90 text-sm sm:text-base md:text-lg max-w-xl mx-auto font-normal leading-relaxed">
            We hunt down jobs posted on company career pages, the ones most people never see. Then our AI Monke tunes up your resume, so you&apos;re actually ready for them.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 w-full max-w-md sm:max-w-none">
            <button
              onClick={() => setModalOpen(true)}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-white text-[#09090B] font-bold text-base sm:text-lg px-8 sm:px-10 py-3.5 sm:py-4 min-h-[48px] rounded-xl shadow-lg hover:shadow-xl hover:scale-105 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span>Explore jobs</span>
              <ArrowRight className="w-5 h-5 ml-0.5 stroke-[2.5]" />
            </button>
            <Link
              href="/resume"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-blue-700/80 hover:bg-blue-700 text-white font-bold text-base sm:text-lg px-7 sm:px-8 py-3.5 sm:py-4 min-h-[48px] rounded-xl border border-white/30 shadow-md hover:shadow-lg transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span>Try AI resume tools</span>
            </Link>
          </div>

          <div className="mt-4">
            <AvatarStack
              peopleCount="8,573"
              jobsCount={totalJobs !== null && totalJobs > 0 ? `${totalJobs.toLocaleString()}+` : undefined}
              textColor="text-white"
            />
          </div>
        </div>

        {/* Product Screenshot Mock nested inside hero on blue background, flush with section bottom (32px mt-8 below social-proof line) */}
        <div className="mt-8 max-w-[960px] mx-auto px-3 sm:px-6 relative z-20 pb-0">
          {/* Dotted grid pattern behind top-right corner */}
          <div className="absolute -top-6 -right-1 sm:-top-8 sm:-right-4 pointer-events-none z-0">
            <DotPattern width={160} height={100} dotColor="rgba(255, 255, 255, 0.45)" rows={5} cols={8} />
          </div>

          {/* Dotted grid pattern behind bottom-left corner */}
          <div className="absolute -bottom-6 -left-1 sm:-bottom-8 sm:-left-4 pointer-events-none z-0">
            <DotPattern width={160} height={100} dotColor="rgba(255, 255, 255, 0.45)" rows={5} cols={8} />
          </div>

          <div className="relative z-10">
            <ProductScreenshotMock />
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 3. PROBLEM VS SOLUTION (Comparison)                                       */}
      {/* ========================================================================= */}
      <section className="pt-20 pb-12 lg:pt-[120px] lg:pb-[90px] max-w-content mx-auto px-6">
        <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-12">
          <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider bg-blue-50 px-3 py-1 rounded-full border border-blue-100">
            Comparison
          </span>
          <h2 className="text-3xl font-bold text-[#09090B] sm:text-4xl md:text-[40px] md:leading-[1.2] mt-3">
            Tired of getting auto-rejections?
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Left card: The usual grind */}
          <div className="bg-white border border-[#E4E4E7] rounded-xl p-7 shadow-sm">
            <span className="mb-5 block text-xl font-bold text-[#09090B] pb-4 border-b border-gray-100">
              The usual grind
            </span>
            <ul className="space-y-4">
              {[
                "Scrolling the same feeds. Again.",
                "\"Posted 1 hour ago, 200 applicants\"",
                "Rewriting your resume. Again.",
                "\"Am I even qualified for this?\"",
                "Endless searching",
              ].map((item, idx) => (
                <li key={idx} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <X className="w-3.5 h-3.5 text-red-600 stroke-[3]" />
                  </div>
                  <span className="text-base text-gray-700 leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right card: The Monke way */}
          <div className="bg-white border border-[#E4E4E7] rounded-xl p-7 shadow-sm">
            <span className="mb-5 block text-xl font-bold text-[#09090B] pb-4 border-b border-gray-100">
              The Monke way
            </span>
            <ul className="space-y-4">
              {[
                "Jobs straight from company career pages",
                "Employers you didn't know existed",
                "AI-refined resume",
                "Resume score card",
                "Browse roles worldwide and check each role's eligibility",
              ].map((item, idx) => (
                <li key={idx} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Check className="w-3.5 h-3.5 text-emerald-600 stroke-[3]" />
                  </div>
                  <span className="text-base text-[#09090B] font-medium leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* AI Resume Monke Section */}
        <div className="mt-12 p-6 sm:p-8 bg-slate-50 border border-slate-200 rounded-2xl max-w-4xl mx-auto shadow-2xs">
          <div className="text-center mb-6">
            <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">
              AI Resume Monke
            </span>
            <h3 className="text-xl sm:text-2xl font-bold text-slate-900 mt-2">
              Meet the monke that fixes your resume.
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-center">
            <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="w-8 h-8 mx-auto rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center mb-2.5">
                  1
                </div>
                <div className="text-sm font-bold text-slate-900">Upload your resume</div>
                <p className="text-xs text-slate-500 mt-1">PDF or Word, the monke isn&apos;t picky.</p>
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="w-8 h-8 mx-auto rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center mb-2.5">
                  2
                </div>
                <div className="text-sm font-bold text-slate-900">Check the details</div>
                <p className="text-xs text-slate-500 mt-1">It reads fast, but you know your career best. Fix anything it got wrong.</p>
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="w-8 h-8 mx-auto rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center mb-2.5">
                  3
                </div>
                <div className="text-sm font-bold text-slate-900">Download a clean version</div>
                <p className="text-xs text-slate-500 mt-1">Simple, single-column, recruiter-friendly.</p>
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
              <div>
                <div className="w-8 h-8 mx-auto rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center mb-2.5">
                  4
                </div>
                <div className="text-sm font-bold text-slate-900">Check the fit</div>
                <p className="text-xs text-slate-500 mt-1">See where you match and what&apos;s missing, before you hit apply.</p>
              </div>
            </div>
          </div>
          <div className="mt-6 text-center">
            <Link
              href="/resume"
              className="inline-flex items-center justify-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm sm:text-base px-6 py-3 min-h-[44px] rounded-xl shadow-sm transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <span>Try AI resume tools</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 4. MARQUEE TESTIMONIALS (Dual-row auto-scrolling marquee)                 */}
      {/* ========================================================================= */}
      <section className="py-14 sm:py-20 bg-white w-full overflow-hidden border-t border-gray-100">
        <div className="max-w-3xl mx-auto px-6 text-center mb-10 sm:mb-12">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border border-blue-100 text-[#2563EB] bg-blue-50/80 mb-3 shadow-xs">
            <span>Wall of Love</span>
          </div>
          <h2 className="text-3xl font-bold text-[#09090B] sm:text-4xl md:text-[40px] md:leading-[1.2] tracking-tight">
            Loved by job seekers skipping the crowd
          </h2>
          <p className="mt-2.5 text-sm sm:text-base text-gray-600 max-w-xl mx-auto">
            See how professionals bypass recruiter markups and public job board spam to land direct offers.
          </p>
        </div>
        <TestimonialMarqueeDemo />
      </section>

      {/* ========================================================================= */}
      {/* 5. CTA BAND (Blue #2563EB, Free Preview style)                            */}
      {/* ========================================================================= */}
      <section className="bg-[#2563EB] text-white py-16 sm:py-20 lg:py-24 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:24px_24px]" />
        <div className="max-w-3xl mx-auto px-6 text-center relative z-10 space-y-4 sm:space-y-5">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight">
            Free preview
          </h2>
          <p className="text-white/90 text-base sm:text-lg max-w-xl mx-auto leading-relaxed font-normal">
            No commitment. Just window shopping for your dream job. Job maxxing starts here.
          </p>
          <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
            <WhiteHeroButton onClick={() => setModalOpen(true)} className="px-8 min-w-[200px]">
              View Jobs
            </WhiteHeroButton>
            <Link
              href="/jobs"
              className="inline-flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-800 text-white border border-white/30 font-bold text-sm sm:text-base px-6 py-3.5 min-h-[44px] rounded-xl shadow-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span>See my Ideal Match</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 5B. GLOBAL COVERAGE SECTION (Dotted Wireframe Globe + Details)            */}
      {/* ========================================================================= */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-2 items-center gap-10 lg:gap-12">
          {/* Right-side text block (stacked first on mobile via order-1) */}
          <div className="order-1 lg:order-2 space-y-5 text-center lg:text-left">
            <div>
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border border-gray-200 text-gray-700 bg-white shadow-sm">
                Global map / radar
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl md:text-[42px] font-bold text-[#09090B] tracking-tight leading-tight">
              Your next role might be in a city you haven&apos;t thought of yet.
            </h2>
            <p className="text-gray-600 text-base sm:text-lg leading-relaxed max-w-xl mx-auto lg:mx-0">
              Look beyond the companies already on your radar. Work under the Bangalore sky or in Paris with a morning coffee. Explore listings by location and check each role&apos;s work setup and eligibility.
            </p>
            <div className="pt-2 flex flex-wrap items-center justify-center lg:justify-start gap-3 w-full">
              <Link
                href="/jobs"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-base sm:text-lg px-8 sm:px-10 py-3.5 sm:py-4 min-h-[48px] rounded-xl shadow-md hover:shadow-xl hover:scale-105 transition-all cursor-pointer"
              >
                <span>View Jobs</span>
                <ArrowRight className="w-5 h-5 ml-0.5 stroke-[2.5]" />
              </Link>
              <Link
                href="/radar"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white hover:bg-slate-50 text-[#0F172A] border border-[#CBD5E1] font-bold text-sm sm:text-base px-6 py-3.5 min-h-[48px] rounded-xl shadow-sm transition-all cursor-pointer"
              >
                <span>Open interactive map</span>
                <span className="text-xs text-[#64748B] font-normal">(Sign-in required)</span>
              </Link>
            </div>

            {/* LIVE STATS row directly under View Jobs button */}
            <GlobeLiveStats />
          </div>

          {/* Left-side globe (stacked below on mobile via order-2) */}
          <div className="order-2 lg:order-1 w-full max-w-[480px] mx-auto lg:max-w-none">
            <WireframeDottedGlobe />
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 6. FOUNDER CARD (Centered bordered card ~670px)                           */}
      {/* ========================================================================= */}
      <section className="pt-16 pb-12 lg:pt-20 lg:pb-16 max-w-content mx-auto px-6 w-full">
        <div className="max-w-[670px] mx-auto bg-white border border-[#E4E4E7] rounded-xl p-8 sm:p-10 shadow-sm">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-left">
            {/* Left: Round photo + My TikTok Videos button */}
            <div className="flex flex-col items-center flex-shrink-0 space-y-3">
              <div className="relative w-28 h-28 rounded-full overflow-hidden border-2 border-blue-500 shadow-md">
                <Image
                  src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=160&h=160&q=75"
                  alt="Roman - Creator of CareerMonke"
                  fill
                  className="object-cover"
                  sizes="112px"
                />
              </div>
              <a
                href="https://tiktok.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-700 hover:text-black border border-gray-300 px-3.5 py-2 min-h-[44px] rounded-md hover:bg-gray-50 transition-colors"
              >
                <span>My TikTok Videos</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </div>

            {/* Right: Name, role, story, 3 stats */}
            <div className="space-y-4">
              <div>
                <h3 className="text-2xl font-bold text-[#09090B]">Roman here, saying hello.</h3>
                <p className="text-sm font-medium text-gray-500">Creator of CareerMonke</p>
              </div>

              <p className="text-[#4B5563] text-base leading-relaxed">
                I wasn&apos;t getting anywhere with LinkedIn, but it wasn&apos;t my fault. A lot of job postings aren&apos;t even real, and it&apos;s too competitive. My friend showed me a simpler way: apply directly to company websites. So I built this tool to find hidden jobs.
              </p>

              {/* 3 Stats: 17M+ Views / 70K+ Followers / 900k+ Likes */}
              <div className="pt-2 border-t border-gray-100 grid grid-cols-3 gap-3 text-center sm:text-left">
                <div>
                  <div className="text-lg font-bold text-[#09090B]">17M+</div>
                  <div className="text-xs text-gray-500">Views</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-[#09090B]">70K+</div>
                  <div className="text-xs text-gray-500">Followers</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-[#09090B]">900k+</div>
                  <div className="text-xs text-gray-500">Likes</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 7. SCROLLING WALL OF LOVE (8,573 job seekers are using Career Hound)     */}
      {/* ========================================================================= */}
      <Testimonials />

      {/* ========================================================================= */}
      {/* 8. FAQ (Gray-100 bg #F3F4F6, centered H2, 5 Q&A items, max-width ~670px) */}
      {/* ========================================================================= */}
      <section className="bg-[#F3F4F6] py-16 sm:py-20 lg:py-24">
        <div className="max-w-[670px] mx-auto px-6">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold sm:text-4xl md:text-[40px] md:leading-[1.2] tracking-tight text-center text-[#09090B]">
              Frequently Asked Questions
            </h2>
          </div>

          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-gray-200/80 shadow-sm divide-y divide-gray-100">
            <FaqHomeItem
              question="How is CareerMonke different from LinkedIn or Indeed?"
              answer="Conventional job boards require employers to manually publish and pay for sponsored placements, creating massive applicant backlogs and ghost listings. CareerMonke automatically scrapes verified company career portals and ATS feeds directly every 15 minutes, uncovering open roles before they are publicized on aggregators."
            />
            <FaqHomeItem
              question="Do you take a percentage of my compensation if I get hired?"
              answer="Never. We are not a staffing agency, headhunter, or contingency recruiter. 100% of your compensation, equity offer, and signing bonus stays with you. We simply give you direct, unmediated access to open employer requisitions."
            />
            <FaqHomeItem
              question="How often are the job feeds and ATS links updated?"
              answer="Our automated ingestion pipeline continuously synchronizes directly with top ATS platforms (Greenhouse, Ashby, Lever, Workday) 24/7. When an employer creates or removes a requisition, our radar updates in real time so you never waste time applying to expired positions."
            />
            <FaqHomeItem
              question="Can I filter jobs by remote status, country, and tech stack?"
              answer="Yes! You can filter requisitions by global worldwide eligibility, timezone requirements, specific tech stacks (e.g., React, Node, Python, AI/ML), and seniority levels to find matches that fit your exact background."
            />
            <FaqHomeItem
              question="Do I apply directly on the company website?"
              answer="Yes, 100% of the time. Every job on CareerMonke links directly to the official company careers page or official ATS application form. There are no middleman forms, third-party redirects, or spam filters between you and the hiring team."
            />
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 10. CONTACT (Gray-50 bg #F9FAFB, id="contact")                            */}
      {/* ========================================================================= */}
      <section id="contact" className="bg-[#F9FAFB] py-16 sm:py-20 border-t border-gray-200/60">
        <div className="max-w-xl mx-auto px-6 text-center space-y-3">
          <h2 className="text-3xl font-bold sm:text-4xl md:text-[40px] md:leading-[1.2] tracking-tight text-[#09090B]">
            Contact us
          </h2>
          <p className="text-gray-600 text-sm sm:text-base">
            We&apos;ll try to respond the same day.
          </p>
          <div className="pt-2">
            <a
              href="mailto:support@careermonke.com"
              className="w-full sm:w-auto inline-flex items-center justify-center bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium px-8 py-3.5 min-h-[48px] rounded-lg text-sm sm:text-base transition-colors shadow-sm"
            >
              <span>support@careermonke.com</span>
            </a>
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 13. FOOTER (Navy #090E34) & BackToTop Button                              */}
      {/* ========================================================================= */}
      <Footer />

      {/* Category selection modal triggered by both "View Jobs" buttons */}
      <CategorySelectModal open={modalOpen} onOpenChange={setModalOpen} />
    </main>
  );
}
