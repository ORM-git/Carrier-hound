import type { Metadata } from "next";
import Link from "next/link";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import LandingJobsTickerStrip from "@/components/LandingJobsTickerStrip";
import Chip from "@/components/Chip";
import { buttonClasses } from "@/components/ui/button";
import { TestimonialsWithMarquee } from "@/components/blocks/testimonials-with-marquee";
import { FULL_REVIEWS } from "@/data/testimonials";

export const metadata: Metadata = {
  title: "CareerMonke — Jobs matched to your resume",
  description:
    "Find verified employer jobs and see a resume match score on every listing before you apply.",
  alternates: { canonical: "/home-v2" },
};

const SAMPLE_JOBS = [
  {
    company: "Lumen Labs",
    title: "Frontend Developer",
    salary: "$95K – $125K",
    location: "Bengaluru, India",
    skills: ["React", "TypeScript"],
  },
  {
    company: "Brightline",
    title: "Data Analyst",
    salary: "$80K – $105K",
    location: "Remote · Worldwide",
    skills: ["SQL", "Python"],
  },
];

const COMPARE_ROWS = [
  {
    generic: "No match score shown — you guess if you're qualified",
    cm: "Every job shows a resume match % before you apply",
  },
  {
    generic: "Same 800+ applicant pool on every listing",
    cm: "Ranked by fit, not by who applied first",
  },
  {
    generic: "Keyword-stuffed descriptions, no feedback on gaps",
    cm: "See exactly which skills are missing, per job",
  },
  {
    generic: "Apply blind and wait to hear back",
    cm: "Apply to the roles you already match best",
  },
];

const FEATURES = [
  {
    num: "1",
    title: "Explore jobs by city",
    body: "Work setup and eligibility, checked.",
    href: "/radar",
    cta: "Open the map",
  },
  {
    num: "2",
    title: "Verified employer jobs",
    body: "Reposts and expired ads dropped.",
    href: "/jobs",
    cta: "Explore jobs",
  },
  {
    num: "3",
    title: "Personalized matches",
    body: "Know your fit before applying.",
    href: "/signup",
    cta: "Find my matches",
  },
];

const FAQS = [
  {
    q: "How is CareerMonke different from LinkedIn or Indeed?",
    a: "Conventional job boards rely on sponsored placements, which creates huge applicant backlogs and ghost listings. CareerMonke focuses on verified, active openings so you spend your time on roles that are actually hiring.",
  },
  {
    q: "Do you take a percentage of my compensation if I get hired?",
    a: "Never. We are not a staffing agency, headhunter, or contingency recruiter. 100% of your compensation, equity offer, and signing bonus stays with you.",
  },
  {
    q: "How often are the job feeds and ATS links updated?",
    a: "Our job listings are refreshed regularly, and expired or closed positions are removed so you don't waste time applying to roles that are no longer open.",
  },
  {
    q: "Can I filter jobs by remote status, country, and tech stack?",
    a: "Yes. You can filter by worldwide eligibility, timezone requirements, specific tech stacks, and seniority levels to find matches that fit your exact background.",
  },
  {
    q: "Do I apply directly on the company website?",
    a: "Yes, 100% of the time. Every job on CareerMonke links directly to the official company careers page or ATS application form.",
  },
];

export default function HomeV2Page() {
  return (
    <div className="min-h-screen bg-white text-[#0F172A] flex flex-col pb-20">
      <GuideHeader />

      <main id="main-content" className="flex-1">
        {/* HERO */}
        <section className="px-4 sm:px-6 pt-10 sm:pt-16 pb-12 sm:pb-16 max-w-5xl mx-auto text-center">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] text-[#1D4ED8] text-[12px] font-medium px-3 py-1 mb-5">
            1,240 new jobs found today
          </p>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight leading-tight">
            Skip LinkedIn competition.
            <br className="hidden sm:block" /> Start job
            <span className="text-[#2563EB]">maxx</span>ing with AI.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-[#475569] max-w-2xl mx-auto">
            Find verified employer jobs and tailor your resume to clear their ATS in seconds.
          </p>

          {/* social proof row */}
          <div className="mt-6 flex items-center justify-center gap-3 text-sm text-[#475569]">
            <div className="flex -space-x-2" aria-hidden="true">
              {["male-1", "female-2", "male-4", "female-5"].map((f) => (
                <img
                  key={f}
                  src={`/images/avatars/${f}.webp`}
                  alt=""
                  width={28}
                  height={28}
                  loading="lazy"
                  className="w-7 h-7 rounded-full border-2 border-white object-cover"
                />
              ))}
            </div>
            <span>Thousands of job seekers already job-maxxing</span>
          </div>

          {/* sample job cards */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2 max-w-3xl mx-auto text-left">
            {SAMPLE_JOBS.map((job) => (
              <div
                key={job.company}
                className="rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-[#0F172A]">{job.title}</h3>
                    <p className="text-sm text-[#475569]">{job.company}</p>
                  </div>
                  <Chip variant="salary">{job.salary}</Chip>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Chip variant="blue">Remote</Chip>
                  <Chip variant="default">Full-time</Chip>
                  {job.skills.map((s) => (
                    <Chip key={s} variant="outline">
                      {s}
                    </Chip>
                  ))}
                </div>
                <p className="mt-3 text-xs text-[#64748B]">{job.location}</p>
                <Link
                  href="/jobs"
                  className={buttonClasses({ variant: "outline", size: "sm", fullWidth: true, className: "mt-4" })}
                >
                  View job
                </Link>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col items-center gap-1.5">
            <Link
              href="/jobs"
              className={buttonClasses({ variant: "primary", size: "lg", className: "px-10 text-base" })}
            >
              View Jobs
            </Link>
            <span className="text-xs text-[#64748B]">Free preview</span>
          </div>
        </section>

        {/* STATS STRIP */}
        <section className="border-y border-[#E2E8F0] bg-[#F8FAFF] py-10" aria-label="CareerMonke in numbers">
          <dl className="max-w-4xl mx-auto grid grid-cols-3 gap-6 text-center px-4">
            <div>
              <dd className="text-3xl sm:text-4xl font-extrabold">3x</dd>
              <dt className="mt-1 text-sm text-[#475569]">higher callback rate</dt>
            </div>
            <div>
              <dd className="text-3xl sm:text-4xl font-extrabold">94%</dd>
              <dt className="mt-1 text-sm text-[#475569]">ATS-aligned words</dt>
            </div>
            <div>
              <dd className="text-3xl sm:text-4xl font-extrabold">1,200</dd>
              <dt className="mt-1 text-sm text-[#475569]">fresh jobs</dt>
            </div>
          </dl>
        </section>

        {/* TICKER (real existing job data) */}
        <LandingJobsTickerStrip />

        {/* COMPARISON */}
        <section className="px-4 sm:px-6 py-14 sm:py-20 max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center">
            Matched to your resume, not just a keyword search
          </h2>
          <p className="mt-2 text-center text-[#475569]">
            Every job on CareerMonke shows a match score against your resume — generic boards don&apos;t.
          </p>
          <div className="mt-8 overflow-hidden rounded-2xl border border-[#E2E8F0]">
            <table className="w-full text-sm">
              <caption className="sr-only">Generic job board compared with CareerMonke</caption>
              <thead>
                <tr className="bg-[#F8FAFC]">
                  <th scope="col" className="text-left font-semibold text-[#475569] px-4 sm:px-6 py-3">
                    Generic job board
                  </th>
                  <th scope="col" className="text-left font-semibold text-[#1D4ED8] px-4 sm:px-6 py-3">
                    CareerMonke
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.cm}>
                    <td className="px-4 sm:px-6 py-4 text-[#475569] align-top">
                      <span className="mr-2 text-[#CBD5E1]" aria-hidden="true">✕</span>
                      {row.generic}
                    </td>
                    <td className="px-4 sm:px-6 py-4 text-[#0F172A] align-top font-medium">
                      <span className="mr-2 text-[#16A34A]" aria-hidden="true">✓</span>
                      {row.cm}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* FEATURES (existing features, minus AI resume) */}
        <section className="px-4 sm:px-6 py-14 sm:py-20 max-w-5xl mx-auto bg-[#F8FAFF]">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-10">The whole hunt, in one place</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.num} className="rounded-2xl border border-[#E2E8F0] bg-white p-6 flex flex-col">
                <span className="text-xs font-bold text-[#1D4ED8]" aria-hidden="true">{f.num}</span>
                <h3 className="mt-2 font-bold text-[#0F172A]">{f.title}</h3>
                <p className="mt-1 text-sm text-[#475569] flex-1">{f.body}</p>
                <Link
                  href={f.href}
                  className={buttonClasses({ variant: "outline", size: "sm", className: "mt-4 self-start" })}
                >
                  {f.cta}
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* CREATOR */}
        <section className="px-4 sm:px-6 py-14 sm:py-20 max-w-3xl mx-auto">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 rounded-2xl border border-[#E2E8F0] p-6 sm:p-8">
            <img
              src="/owner.jpg"
              alt="Orissa Lee Patnaik, founder of CareerMonke"
              width={112}
              height={112}
              loading="lazy"
              className="w-28 h-28 rounded-full object-cover shrink-0"
            />
            <div>
              <h2 className="text-xl font-bold">Orissa here!</h2>
              <p className="text-sm text-[#475569] font-medium">Creator of CareerMonke</p>
              <p className="mt-3 text-sm text-[#475569]">
                Growing up in the US and living in India showed me the friction of job hunting is universal. Broken
                software discards qualified people, and legacy sites make every role a cattle call.
              </p>
              <p className="mt-2 text-sm text-[#475569]">
                I built CareerMonke to cut through the noise, give candidates leverage back, and land your story
                directly with real people without the unnecessary hollow hustle rhetoric.
              </p>
              <div className="mt-4 flex items-center gap-4 text-[#475569]">
                <a
                  href="https://www.instagram.com/orissa.patnaik"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="hover:text-[#1D4ED8]"
                >
                  Instagram
                </a>
                <a
                  href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="hover:text-[#1D4ED8]"
                >
                  LinkedIn
                </a>
                <a href="mailto:support@careermonke.com" aria-label="Email" className="hover:text-[#1D4ED8]">
                  Email
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* WALL OF TESTIMONIALS (real reviews from data/testimonials.ts) */}
        <TestimonialsWithMarquee
          title="From job seekers who found it worked"
          description="Real reviews from CareerMonke users — nothing invented."
          testimonials={FULL_REVIEWS.map((r) => ({
            author: { name: r.name, handle: r.handle, avatar: "" },
            text: r.quote,
          }))}
        />

        {/* FAQ */}
        <section className="px-4 sm:px-6 py-14 sm:py-20 max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-8">Frequently asked questions</h2>
          <div className="divide-y divide-[#E2E8F0] rounded-2xl border border-[#E2E8F0]">
            {FAQS.map((item) => (
              <details key={item.q} className="group p-5">
                <summary className="font-semibold text-[#0F172A] cursor-pointer list-none">{item.q}</summary>
                <p className="mt-2 text-sm text-[#475569]">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* CONTACT */}
        <section className="px-4 sm:px-6 py-14 sm:py-20 max-w-xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold">Contact us</h2>
          <p className="mt-2 text-[#475569]">We&apos;ll try to respond the same day.</p>
          <a
            href="mailto:support@careermonke.com"
            className={buttonClasses({ variant: "outline", size: "md", className: "mt-4 inline-flex" })}
          >
            support@careermonke.com
          </a>
        </section>

        {/* FREE PREVIEW */}
        <section className="bg-[#0F172A] text-white py-14 sm:py-20 text-center px-4">
          <h2 className="text-2xl sm:text-3xl font-bold">Free preview</h2>
          <p className="mt-2 text-white/70 max-w-md mx-auto">
            No commitment. Just window shopping for your dream job. Job maxxing starts here.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/jobs"
              className={buttonClasses({ variant: "primary", size: "lg", className: "px-8" })}
            >
              View Jobs
            </Link>
            <Link
              href="/signup"
              className={buttonClasses({ variant: "outline", size: "lg", className: "px-8 bg-transparent text-white border-white/40 hover:border-white hover:bg-white/10" })}
            >
              See my Ideal Match
            </Link>
          </div>
        </section>
      </main>

      <Footer />

      {/* sticky bottom bar, visible through the whole scroll */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-[#E2E8F0] bg-white/95 backdrop-blur px-4 py-3">
        <Link
          href="/jobs"
          className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true, className: "max-w-sm mx-auto flex" })}
        >
          View Jobs
        </Link>
      </div>
    </div>
  );
}
