"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Script from "next/script";
import { FaqHomeItem } from "@/components/FaqItems";
import { WhiteHeroButton } from "@/components/Buttons";
import CategorySelectModal from "@/components/CategorySelectModal";
import Footer from "@/components/Footer";
import GlobeLiveStats from "@/components/GlobeLiveStats";
import LandingTopArtifact from "@/components/LandingTopArtifact";
import LandingFeaturesSection from "@/components/LandingFeaturesSection";
import LandingCredibilitySection from "@/components/LandingCredibilitySection";
import LandingComparisonSection from "@/components/LandingComparisonSection";
import LandingJobsTickerStrip from "@/components/LandingJobsTickerStrip";
import "@/styles/landing-top-artifact.css";
import { ArrowRight, Instagram, Linkedin, Mail } from "lucide-react";

const WireframeDottedGlobe = dynamic(
  () => import("@/components/ui/wireframe-dotted-globe"),
  { ssr: false }
);

const Testimonials = dynamic(
  () => import("@/components/testimonials").then((m) => m.Testimonials),
  { ssr: false }
);

export default function HomePage() {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);

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
      <Script src="/careermonke-visuals.js" strategy="afterInteractive" />

      {/* (1) TOP ARTIFACT: Sticky Nav, Hero, and Demo Band */}
      <LandingTopArtifact />

      {/* (2) PRODUCT FEATURES SECTION */}
      <LandingFeaturesSection />

      {/* (3) JOBS JUST ADDED TICKER STRIP */}
      <LandingJobsTickerStrip />

      {/* (4) PROBLEM VS SOLUTION (Comparison) */}
      <section className="pt-24 pb-12 lg:pt-28 lg:pb-[90px] max-w-content mx-auto px-6">
        <LandingComparisonSection />

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
              href="/early-access"
              className="inline-flex items-center justify-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm sm:text-base px-6 py-3 min-h-[44px] rounded-xl shadow-sm transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <span>Try AI resume tools</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* (5) GLOBAL COVERAGE SECTION (Dotted Wireframe Globe + Details) */}
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
                href="/early-access"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-base sm:text-lg px-8 sm:px-10 py-3.5 sm:py-4 min-h-[48px] rounded-xl shadow-md hover:shadow-xl hover:scale-105 transition-all cursor-pointer"
              >
                <span>View Jobs</span>
                <ArrowRight className="w-5 h-5 ml-0.5 stroke-[2.5]" />
              </Link>
              <Link
                href="/early-access"
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

      {/* (6) CTA BAND (Blue #2563EB, Free Preview style) */}
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
            <WhiteHeroButton onClick={() => router.push("/early-access")} className="px-8 min-w-[200px]">
              View Jobs
            </WhiteHeroButton>
            <Link
              href="/early-access"
              className="inline-flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-800 text-white border border-white/30 font-bold text-sm sm:text-base px-6 py-3.5 min-h-[48px] rounded-xl shadow-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span>See my Ideal Match</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* (7) BIO (Founder Card) */}
      <section className="pt-10 pb-8 sm:pt-12 sm:pb-10 lg:pt-14 lg:pb-12 max-w-content mx-auto px-6 w-full">
        <div className="max-w-[670px] mx-auto bg-white border border-[#E4E4E7] rounded-xl p-6 sm:p-8 shadow-sm">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-left">
            {/* Left: Round photo */}
            <div className="flex flex-col items-center flex-shrink-0">
              <div className="relative w-28 h-28 rounded-full overflow-hidden border-2 border-blue-500 shadow-md">
                <Image
                  src="/owner.jpg"
                  alt="Orissa Lee Patnaik, Founder"
                  width={112}
                  height={112}
                  className="w-full h-full object-cover"
                  priority
                />
              </div>
            </div>

            {/* Right: Name, role, story */}
            <div className="space-y-3">
              <div>
                <h3 className="text-2xl font-bold text-[#09090B]">Orissa here!</h3>
                <p className="text-sm font-medium text-gray-500">Creator of CareerMonke</p>
              </div>

              <div className="space-y-2 text-[#4B5563] text-base leading-relaxed">
                <p>
                  Growing up in the US and living in India showed me the friction of job hunting is universal. Broken software discards qualified people, and legacy sites make every role a cattle call.
                </p>
                <p>
                  I built CareerMonke to cut through the noise, give candidates leverage back, and land your story directly with real people without the unnecessary hollow hustle rhetoric.
                </p>
              </div>

              {/* Founder social links */}
              <div className="flex items-center justify-center sm:justify-start gap-3 pt-1">
                <a
                  href="https://www.instagram.com/orissa.patnaik"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="text-gray-500 hover:text-gray-900 transition-colors p-1.5 rounded-full hover:bg-gray-100"
                >
                  <Instagram className="w-4 h-4" />
                </a>
                <a
                  href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="text-gray-500 hover:text-gray-900 transition-colors p-1.5 rounded-full hover:bg-gray-100"
                >
                  <Linkedin className="w-4 h-4" />
                </a>
                <a
                  href="mailto:orissaleepatnaik@gmail.com"
                  aria-label="Email"
                  className="text-gray-500 hover:text-gray-900 transition-colors p-1.5 rounded-full hover:bg-gray-100"
                >
                  <Mail className="w-4 h-4" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEEDBACK / TESTIMONIALS */}
      <Testimonials />

      {/* FAQ (Gray-100 bg #F3F4F6, centered H2, 5 Q&A items, max-width ~670px) */}
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

      {/* CONTACT US (Gray-50 bg #F9FAFB, id="contact") */}
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

      {/* (8) CREDIBILITY SECTION "Real numbers, not promises" */}
      <LandingCredibilitySection />

      {/* (9) FOOTER (Navy #090E34) & BackToTop Button */}
      <Footer />

      {/* Category selection modal triggered by both "View Jobs" buttons */}
      <CategorySelectModal open={modalOpen} onOpenChange={setModalOpen} />
    </main>
  );
}
