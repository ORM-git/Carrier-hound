"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  Lock,
} from "lucide-react";

export interface DemoJobSample {
  id: string;
  title: string;
  company: string;
  monogram: string;
  location: string;
  matchScore: number;
  matchedSkills: string[];
  missingSkill: string;
  tailoredSummary: string;
  coverLetterExcerpt: string;
}

export interface DemoRolePreset {
  id: string;
  label: string;
  subtitle: string;
  coreSkills: string[];
  jobs: DemoJobSample[];
}

export const DEMO_ROLES: DemoRolePreset[] = [
  {
    id: "backend",
    label: "Backend & Systems",
    subtitle: "TypeScript · Node.js · PostgreSQL · Docker",
    coreSkills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
    jobs: [
      {
        id: "be-1",
        title: "Senior Backend Engineer",
        company: "Sample Cloud Systems",
        monogram: "SC",
        location: "Remote",
        matchScore: 94,
        matchedSkills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
        missingSkill: "Kafka",
        tailoredSummary:
          "Backend Engineer experienced in TypeScript, Node.js, and PostgreSQL, building resilient APIs and distributed services.",
        coverLetterExcerpt:
          "Dear Sample Cloud Systems Team — My background scaling TypeScript and Node.js services aligns directly with your platform roadmap.",
      },
    ],
  },
  {
    id: "frontend",
    label: "Frontend & UI",
    subtitle: "React · Next.js · TypeScript · Tailwind",
    coreSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS"],
    jobs: [
      {
        id: "fe-1",
        title: "Senior Frontend Engineer",
        company: "Sample Workspace Studio",
        monogram: "SW",
        location: "Remote",
        matchScore: 94,
        matchedSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS"],
        missingSkill: "Storybook",
        tailoredSummary:
          "Frontend Engineer focused on accessible React, Next.js, and TypeScript component primitives and responsive user interfaces.",
        coverLetterExcerpt:
          "Dear Sample Workspace Studio Team — Building accessible UI systems in React and TypeScript has been the core of my work.",
      },
    ],
  },
  {
    id: "data",
    label: "Data & ML",
    subtitle: "Python · SQL · PostgreSQL · Pipelines",
    coreSkills: ["Python", "SQL", "PostgreSQL", "Data Pipelines"],
    jobs: [
      {
        id: "da-1",
        title: "Senior Data Platform Engineer",
        company: "Sample Telemetry Corp",
        monogram: "ST",
        location: "Remote",
        matchScore: 94,
        matchedSkills: ["Python", "SQL", "PostgreSQL", "Data Pipelines"],
        missingSkill: "Airflow",
        tailoredSummary:
          "Data Platform Engineer skilled in Python, SQL, and PostgreSQL data modeling, building reliable data pipelines.",
        coverLetterExcerpt:
          "Dear Sample Telemetry Corp Team — My work designing observable Python and SQL pipelines maps directly to your data goals.",
      },
    ],
  },
  {
    id: "design",
    label: "Product Design",
    subtitle: "Product Design · Systems · Prototyping",
    coreSkills: ["Product Design", "Design Systems", "Prototyping", "Accessibility"],
    jobs: [
      {
        id: "pd-1",
        title: "Staff Product Designer",
        company: "Sample Collab Docs",
        monogram: "SC",
        location: "Remote",
        matchScore: 94,
        matchedSkills: ["Product Design", "Design Systems", "Prototyping", "Accessibility"],
        missingSkill: "Motion Design",
        tailoredSummary:
          "Product Designer experienced in end-to-end user workflows, interactive prototyping, and accessible design systems.",
        coverLetterExcerpt:
          "Dear Sample Collab Docs Team — I love simplifying complex workflows into calm, intuitive interfaces backed by a cohesive design system.",
      },
    ],
  },
];

export const STEP_TABS = [
  { step: 1 as const, label: "Find" },
  { step: 2 as const, label: "Match" },
  { step: 3 as const, label: "Improve" },
  { step: 4 as const, label: "Start" },
];

const CLIENT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function IllustrationSampleBadge({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="illustration-sample-badge"
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-normal bg-slate-100 text-slate-500 border border-slate-200/80 leading-tight ${className}`}
    >
      Illustration - sample data
    </span>
  );
}

export default function LandingInteractiveDemoSection() {
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedRoleId, setSelectedRoleId] = useState<string>(DEMO_ROLES[0].id);
  const [showCoverLetter, setShowCoverLetter] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  // Score counter animation state (counts 0 to 94 over 600ms on first view)
  const [animatedScore, setAnimatedScore] = useState<number>(94);
  const [hasAnimatedScore, setHasAnimatedScore] = useState(false);

  // Email capture state inside Step 4 ("Start")
  const [email, setEmail] = useState<string>("");
  const [website, setWebsite] = useState<string>(""); // Honeypot
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const currentRole =
    DEMO_ROLES.find((r) => r.id === selectedRoleId) || DEMO_ROLES[0];
  const currentJob = currentRole.jobs[0];

  // Detect prefers-reduced-motion
  useEffect(() => {
    if (typeof window !== "undefined") {
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      setPrefersReducedMotion(mediaQuery.matches);
      const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    }
  }, []);

  // Score counter over 600ms on step 2 first view
  useEffect(() => {
    if (activeStep === 2) {
      if (prefersReducedMotion) {
        setAnimatedScore(94);
        return;
      }
      if (!hasAnimatedScore) {
        setHasAnimatedScore(true);
        const startTime = performance.now();
        const duration = 600;
        const target = 94;

        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const eased = 1 - (1 - progress) * (1 - progress);
          setAnimatedScore(Math.round(eased * target));
          if (progress < 1) {
            requestAnimationFrame(animate);
          }
        };

        setAnimatedScore(0);
        requestAnimationFrame(animate);
      }
    }
  }, [activeStep, prefersReducedMotion, hasAnimatedScore]);

  const handleStepClick = (step: 1 | 2 | 3 | 4) => {
    setActiveStep(step);
  };

  const handleSelectRole = (roleId: string) => {
    const found = DEMO_ROLES.find((r) => r.id === roleId) || DEMO_ROLES[0];
    setSelectedRoleId(found.id);
  };

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setSubmitStatus("error");
      setErrorMessage("Please enter your email address.");
      return;
    }

    if (
      trimmed.length < 5 ||
      trimmed.length > 254 ||
      trimmed.includes("..") ||
      /\s/.test(trimmed) ||
      !CLIENT_EMAIL_REGEX.test(trimmed)
    ) {
      setSubmitStatus("error");
      setErrorMessage("Please enter a valid email address.");
      return;
    }

    setSubmitStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: trimmed,
          website,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setSubmitStatus("error");
        setErrorMessage(
          data.error || "Something went wrong. Please try again in a moment."
        );
        return;
      }

      setSubmitStatus("success");
    } catch {
      setSubmitStatus("error");
      setErrorMessage("Network error. Please check your connection and try again.");
    }
  };

  return (
    <div
      data-testid="landing-interactive-demo-section"
      className="w-full max-w-[880px] mx-auto text-left"
    >
      <style>{`
        @keyframes demoFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .animate-demo-fade {
          animation: demoFadeIn 180ms ease-out forwards;
        }
      `}</style>

      {/* Compact browser-style card */}
      <div
        data-testid="compact-browser-demo-card"
        className="w-full bg-white rounded-[20px] sm:rounded-[24px] border border-white/20 shadow-[0_24px_60px_rgba(15,23,42,0.25)] overflow-hidden"
      >
        {/* Browser Top Chrome */}
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {/* 3 Window Control Dots */}
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
            </div>

            {/* careermonke.com pill */}
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white border border-slate-200/80 text-[11px] font-normal text-slate-500">
              <Lock className="w-3 h-3 text-slate-400 stroke-[1.75]" />
              <span>careermonke.com</span>
            </div>
          </div>

          {/* Small Illustration - sample data tag */}
          <IllustrationSampleBadge />
        </div>

        {/* 4 Step Tabs (Labels: 1 Find, 2 Match, 3 Improve, 4 Start — visible at every screen width) */}
        <div
          role="tablist"
          aria-label="Interactive demo steps"
          className="grid grid-cols-4 bg-slate-50/80 border-b border-slate-100"
        >
          {STEP_TABS.map((t) => {
            const isActive = activeStep === t.step;
            return (
              <button
                key={t.step}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`demo-step-tab-${t.step}`}
                onClick={() => handleStepClick(t.step)}
                className={`relative min-h-[44px] py-2 px-1 text-xs sm:text-[13px] transition-colors flex items-center justify-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
                  isActive
                    ? "text-[#2563EB] font-semibold bg-white"
                    : "text-slate-500 font-medium hover:text-slate-800 hover:bg-slate-100/60"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${
                    isActive
                      ? "bg-[#2563EB] text-white"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {t.step}
                </span>
                <span className="font-medium whitespace-nowrap">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Thin blue progress bar filling 25/50/75/100% */}
        <div
          data-testid="demo-progress-bar"
          className="w-full h-1 bg-slate-100 relative overflow-hidden"
        >
          <div
            className={`h-full bg-[#2563EB] ${prefersReducedMotion ? "" : "transition-all duration-200 ease-out"}`}
            style={{
              width: `${activeStep * 25}%`,
            }}
          />
        </div>

        {/* 2-Column Desktop Body / 1-Column Mobile Body */}
        <div className="p-4 sm:p-6 min-h-[310px] sm:h-[280px] overflow-hidden flex flex-col justify-between">
          <div
            key={activeStep}
            className={`h-full flex flex-col justify-between ${prefersReducedMotion ? "" : "animate-demo-fade"}`}
          >
            {/* STEP 1: FIND ("Pick your kind of work") */}
            {activeStep === 1 && (
              <div
                data-testid="demo-step-1-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                      Pick your kind of work
                    </h2>
                    <p className="text-xs sm:text-[13px] font-normal text-slate-500 mt-1 leading-normal">
                      Select what fits your background best.
                    </p>

                    {/* 4 Category Cards (names wrap to two lines, never truncate) */}
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      {DEMO_ROLES.map((role) => {
                        const isSelected = role.id === currentRole.id;
                        return (
                          <button
                            key={role.id}
                            type="button"
                            data-testid={`demo-role-card-${role.id}`}
                            onClick={() => handleSelectRole(role.id)}
                            className={`p-2.5 rounded-xl text-left transition-all cursor-pointer min-h-[48px] flex flex-col justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 ${
                              isSelected
                                ? "bg-blue-50 border-2 border-[#2563EB] text-[#2563EB]"
                                : "bg-slate-50/70 border border-slate-200/80 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                            }`}
                          >
                            <span className="text-xs sm:text-[13px] font-semibold leading-snug block break-words whitespace-normal">
                              {role.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <div className="pt-3 mt-auto">
                    <button
                      type="button"
                      data-testid="demo-step-1-next"
                      onClick={() => handleStepClick(2)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                    >
                      <span>Show my jobs</span>
                      <ArrowRight className="w-4 h-4 stroke-[2]" />
                    </button>
                  </div>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800">
                        Selected Field
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="mt-3">
                      <p className="text-sm font-bold text-slate-900">
                        {currentJob.title}
                      </p>
                      <p className="text-xs font-normal text-slate-500 mt-0.5">
                        {currentJob.company}
                      </p>
                    </div>

                    <div className="mt-3">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-[#2563EB] border border-blue-200/80">
                        Active openings found
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60 flex flex-wrap gap-1.5">
                    {currentRole.coreSkills.map((skill) => (
                      <span
                        key={skill}
                        className="px-2 py-0.5 rounded-full text-[11px] font-normal bg-white border border-slate-200 text-slate-600"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 2: MATCH ("See your match score") */}
            {activeStep === 2 && (
              <div
                data-testid="demo-step-2-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                      See your match score
                    </h2>
                    <p className="text-xs sm:text-[13px] font-normal text-slate-600 mt-1 leading-normal">
                      Your skills match 94% of what this job asks for.
                    </p>

                    {/* ONE sample job card with ONE score */}
                    <div
                      data-testid={`demo-job-card-${currentJob.id}`}
                      className="mt-3 p-3 rounded-xl bg-blue-50/70 border border-[#2563EB] flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs sm:text-[13px] font-bold text-slate-900 leading-tight">
                          {currentJob.title}
                        </p>
                        <p className="text-[11px] font-normal text-slate-500 mt-0.5">
                          {currentJob.company}
                        </p>
                      </div>
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white text-[#2563EB] border border-blue-200 shadow-2xs flex-shrink-0">
                        {animatedScore}%
                      </span>
                    </div>

                    {/* Skill ticks as small supporting text */}
                    <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                      {currentJob.matchedSkills.map((skill) => (
                        <span key={skill} className="inline-flex items-center gap-1 font-medium">
                          <span className="text-emerald-600 font-bold">✓</span>
                          <span>{skill}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <div className="pt-3 mt-auto">
                    <button
                      type="button"
                      data-testid="demo-step-2-next"
                      onClick={() => handleStepClick(3)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                    >
                      <span>Fix my resume for this job</span>
                      <ArrowRight className="w-4 h-4 stroke-[2]" />
                    </button>
                  </div>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800">
                        Match Summary
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="mt-3 p-3 bg-white rounded-xl border border-slate-200 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500 font-medium">Overall match</span>
                        <span className="text-lg font-black text-emerald-600">{animatedScore}%</span>
                      </div>
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden mt-1.5">
                        <div
                          className="h-full bg-emerald-600 rounded-full transition-all duration-300"
                          style={{ width: `${animatedScore}%` }}
                        />
                      </div>
                    </div>

                    <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                      Your profile matches the core requirements for this position.
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60">
                    <p className="text-[11px] font-normal text-slate-500">
                      Suggested addition: {currentJob.missingSkill}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: IMPROVE ("Your improved resume") */}
            {activeStep === 3 && (
              <div
                data-testid="demo-step-3-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                      Your improved resume
                    </h2>
                    <p className="text-xs sm:text-[13px] font-normal text-slate-500 mt-1 leading-normal">
                      Rewritten summary tailored for this position.
                    </p>

                    {/* Rewritten Summary or Swapped Cover Letter */}
                    <div className="mt-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-[13px] text-slate-800 leading-relaxed font-normal">
                      {showCoverLetter
                        ? currentJob.coverLetterExcerpt
                        : currentJob.tailoredSummary}
                    </div>

                    {/* Underlined text link to swap in place */}
                    <div className="mt-1 flex items-center min-h-[44px]">
                      <button
                        type="button"
                        data-testid="demo-swap-doc-link"
                        onClick={() => setShowCoverLetter(!showCoverLetter)}
                        className="inline-flex items-center min-h-[44px] text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2 cursor-pointer font-medium text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                      >
                        {showCoverLetter
                          ? "See the resume summary instead"
                          : "See the cover letter instead"}
                      </button>
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <div className="pt-3 mt-auto">
                    <button
                      type="button"
                      data-testid="demo-step-3-next"
                      onClick={() => handleStepClick(4)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                    >
                      <span>Continue to apply</span>
                      <ArrowRight className="w-4 h-4 stroke-[2]" />
                    </button>
                  </div>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div
                  data-testid="demo-preview-panel"
                  className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]">
                        <FileText className="w-3.5 h-3.5 stroke-[1.75]" />
                        {showCoverLetter ? "Cover Letter Preview" : "Rewritten Summary"}
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <p className="text-[13px] font-normal text-slate-700 leading-relaxed mt-2.5">
                      {showCoverLetter
                        ? currentJob.coverLetterExcerpt
                        : currentJob.tailoredSummary}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60 flex flex-wrap gap-1.5">
                    {currentJob.matchedSkills.slice(0, 3).map((skill) => (
                      <span
                        key={skill}
                        className="px-2 py-0.5 rounded-full text-[11px] font-normal bg-emerald-50 text-emerald-700 border border-emerald-200"
                      >
                        ✓ {skill}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 4: START ("Get started") */}
            {activeStep === 4 && (
              <div
                id="landing-demo-email-capture"
                data-testid="demo-step-4-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                      Get started
                    </h2>
                    <p className="text-xs sm:text-[13px] font-normal text-slate-600 mt-1 leading-normal">
                      Leave your email and we&apos;ll set this up for your real job search.
                    </p>

                    {/* Email Capture / Success State */}
                    <div className="mt-3">
                      {submitStatus === "success" ? (
                        <div
                          data-testid="landing-demo-email-success"
                          className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2"
                        >
                          <div className="flex items-center gap-2 text-emerald-900 font-semibold text-xs">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 stroke-[1.75]" />
                            <span>You&apos;re on the early-access list!</span>
                          </div>
                          <Link
                            href="/early-access"
                            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-3 min-h-[48px] rounded-xl text-xs font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white transition-colors"
                          >
                            <span>Continue to early access</span>
                            <ArrowRight className="w-3.5 h-3.5 stroke-[1.75]" />
                          </Link>
                        </div>
                      ) : (
                        <form
                          onSubmit={handleEmailSubmit}
                          noValidate
                          data-testid="landing-demo-email-capture-form"
                          className="space-y-2"
                        >
                          {/* Honeypot */}
                          <div className="hidden" aria-hidden="true">
                            <label htmlFor="landing-demo-website">Website</label>
                            <input
                              id="landing-demo-website"
                              type="text"
                              name="website"
                              tabIndex={-1}
                              autoComplete="off"
                              value={website}
                              onChange={(e) => setWebsite(e.target.value)}
                            />
                          </div>

                          <div>
                            {/* Visible label above email input */}
                            <label
                              htmlFor="landing-demo-email-input"
                              className="block text-xs font-semibold text-slate-700 mb-1"
                            >
                              Email address
                            </label>
                            <div className="relative">
                              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none stroke-[1.75]" />
                              <input
                                id="landing-demo-email-input"
                                data-testid="landing-demo-email-input"
                                type="email"
                                required
                                aria-label="Email address"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => {
                                  setEmail(e.target.value);
                                  if (submitStatus === "error") {
                                    setSubmitStatus("idle");
                                    setErrorMessage("");
                                  }
                                }}
                                disabled={submitStatus === "submitting"}
                                className="w-full pl-9 pr-3 py-2.5 min-h-[44px] rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                              />
                            </div>
                          </div>

                          {submitStatus === "error" && errorMessage && (
                            <p
                              role="alert"
                              className="text-xs font-normal text-red-600"
                            >
                              {errorMessage}
                            </p>
                          )}

                          {/* Primary Action Button (no arrow) */}
                          <div className="pt-1">
                            <button
                              type="submit"
                              data-testid="landing-demo-email-submit"
                              disabled={submitStatus === "submitting"}
                              className="w-full inline-flex items-center justify-center px-4 py-3 min-h-[48px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                            >
                              {submitStatus === "submitting" ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin stroke-[1.75] mr-2" />
                                  <span>Joining...</span>
                                </>
                              ) : (
                                <span>Get early access</span>
                              )}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800">
                        Next Steps
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="flex items-start gap-2 text-xs text-slate-700">
                        <span className="w-5 h-5 rounded-full bg-blue-100 text-[#2563EB] font-bold text-[11px] flex items-center justify-center flex-shrink-0 mt-0.5">
                          1
                        </span>
                        <p>We set up your custom search based on your skills.</p>
                      </div>
                      <div className="flex items-start gap-2 text-xs text-slate-700">
                        <span className="w-5 h-5 rounded-full bg-blue-100 text-[#2563EB] font-bold text-[11px] flex items-center justify-center flex-shrink-0 mt-0.5">
                          2
                        </span>
                        <p>You get tailored resume adjustments for positions you pick.</p>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60">
                    <p className="text-[11px] font-normal text-slate-500">
                      Zero commitment. Free early preview.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Caption directly under the card */}
      <p
        data-testid="illustration-card-caption"
        className="mt-3 text-center text-[13px] font-normal text-slate-500"
      >
        Illustration - sample companies and scores
      </p>
    </div>
  );
}
