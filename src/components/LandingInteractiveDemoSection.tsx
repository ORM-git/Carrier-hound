"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Sparkles,
  Lock,
} from "lucide-react";

export interface DemoJobSample {
  id: string;
  title: string;
  company: string;
  monogram: string;
  location: string;
  workSetup: string;
  sourceLabel: string;
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
        location: "Remote (Worldwide)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 94,
        matchedSkills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
        missingSkill: "Kafka",
        tailoredSummary:
          "Backend Engineer experienced in TypeScript, Node.js, and PostgreSQL, building resilient APIs and low-latency distributed services aligned with Sample Cloud Systems.",
        coverLetterExcerpt:
          "Dear Sample Cloud Systems Hiring Team — My background scaling TypeScript/Node.js services and tuning PostgreSQL workloads aligns directly with your Core Platform roadmap.",
      },
      {
        id: "be-2",
        title: "Distributed Systems Engineer",
        company: "Sample Payments Infra",
        monogram: "SP",
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 89,
        matchedSkills: ["TypeScript", "Node.js", "PostgreSQL", "REST API"],
        missingSkill: "GraphQL",
        tailoredSummary:
          "Systems Engineer specializing in idempotent payment APIs, Node.js microservices, and transactional PostgreSQL integrity for Sample Payments Infra.",
        coverLetterExcerpt:
          "Dear Sample Payments Infra Team — Having architected high-reliability webhook pipelines in TypeScript and PostgreSQL, I would love to contribute to your settlement platform.",
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
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 93,
        matchedSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS"],
        missingSkill: "Storybook",
        tailoredSummary:
          "Frontend Engineer focused on accessible React, Next.js, and TypeScript component primitives and fast UI rendering for Sample Workspace Studio.",
        coverLetterExcerpt:
          "Dear Sample Workspace Studio Team — Building accessible, keyboard-first UI systems in React and TypeScript has been the core of my work.",
      },
      {
        id: "fe-2",
        title: "Product UI Engineer",
        company: "Sample Analytics Hub",
        monogram: "SA",
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 88,
        matchedSkills: ["React", "TypeScript", "Next.js", "HTML5"],
        missingSkill: "WebGL",
        tailoredSummary:
          "Product UI Engineer delivering responsive Next.js and TypeScript analytics workflows with clean state management for Sample Analytics Hub.",
        coverLetterExcerpt:
          "Dear Sample Analytics Hub Team — I specialize in turning complex telemetry datasets into clear, responsive React and Next.js interfaces.",
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
        location: "Remote (Worldwide)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 92,
        matchedSkills: ["Python", "SQL", "PostgreSQL", "Data Pipelines"],
        missingSkill: "Airflow",
        tailoredSummary:
          "Data Platform Engineer skilled in Python, SQL, and PostgreSQL data modeling, building reliable ingestion pipelines for Sample Telemetry Corp.",
        coverLetterExcerpt:
          "Dear Sample Telemetry Corp Team — My work designing observable Python and SQL ingestion pipelines maps directly to your data platform goals.",
      },
      {
        id: "da-2",
        title: "Applied ML Infra Engineer",
        company: "Sample Search Labs",
        monogram: "SS",
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 87,
        matchedSkills: ["Python", "SQL", "Docker", "Data Pipelines"],
        missingSkill: "PyTorch",
        tailoredSummary:
          "ML Infrastructure Engineer combining Python pipeline automation, SQL evaluation harnesses, and Docker services for Sample Search Labs.",
        coverLetterExcerpt:
          "Dear Sample Search Labs Team — I build reproducible Python data and ranking evaluation pipelines that keep model iterations fast and grounded.",
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
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 95,
        matchedSkills: ["Product Design", "Design Systems", "Prototyping", "Accessibility"],
        missingSkill: "Motion Design",
        tailoredSummary:
          "Staff Product Designer experienced in end-to-end workflow architecture, interactive prototyping, and accessible design systems for Sample Collab Docs.",
        coverLetterExcerpt:
          "Dear Sample Collab Docs Team — I love simplifying complex multi-step workflows into calm, intuitive interfaces backed by a cohesive design system.",
      },
      {
        id: "pd-2",
        title: "Senior Systems Designer",
        company: "Sample Developer Platform",
        monogram: "SD",
        location: "Remote (Global)",
        workSetup: "Direct Career Page",
        sourceLabel: "Direct Career Page",
        matchScore: 90,
        matchedSkills: ["Product Design", "Design Systems", "Accessibility"],
        missingSkill: "Design Tokens",
        tailoredSummary:
          "Senior Systems Designer uniting component governance, WCAG accessibility, and high-craft developer workflows for Sample Developer Platform.",
        coverLetterExcerpt:
          "Dear Sample Developer Platform Team — Designing coherent systems and accessible user flows for technical products is where I do my best work.",
      },
    ],
  },
];

export const STEP_TABS = [
  { step: 1 as const, label: "Find" },
  { step: 2 as const, label: "Match" },
  { step: 3 as const, label: "Tailor" },
  { step: 4 as const, label: "Send" },
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
  const [selectedJobId, setSelectedJobId] = useState<string>(DEMO_ROLES[0].jobs[0].id);
  const [docTab, setDocTab] = useState<"resume" | "coverLetter">("resume");
  const [userInteracted, setUserInteracted] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  // Email capture state inside Step 4 ("Send")
  const [email, setEmail] = useState<string>("");
  const [website, setWebsite] = useState<string>(""); // Honeypot
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const currentRole =
    DEMO_ROLES.find((r) => r.id === selectedRoleId) || DEMO_ROLES[0];
  const currentJob =
    currentRole.jobs.find((j) => j.id === selectedJobId) || currentRole.jobs[0];

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

  // Auto-advance every 4.5s until user interaction or if reduced motion is requested
  useEffect(() => {
    if (userInteracted || prefersReducedMotion) return;

    const timer = setInterval(() => {
      setActiveStep((prev) => (prev === 4 ? 1 : ((prev + 1) as 1 | 2 | 3 | 4)));
    }, 4500);

    return () => clearInterval(timer);
  }, [userInteracted, prefersReducedMotion]);

  const handleStepClick = (step: 1 | 2 | 3 | 4) => {
    setUserInteracted(true);
    setActiveStep(step);
  };

  const handleSelectRole = (roleId: string) => {
    setUserInteracted(true);
    const found = DEMO_ROLES.find((r) => r.id === roleId) || DEMO_ROLES[0];
    setSelectedRoleId(found.id);
    setSelectedJobId(found.jobs[0].id);
  };

  const handleSelectJob = (jobId: string) => {
    setUserInteracted(true);
    setSelectedJobId(jobId);
  };

  const handleDocTabChange = (tab: "resume" | "coverLetter") => {
    setUserInteracted(true);
    setDocTab(tab);
  };

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUserInteracted(true);

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
        @keyframes demoStepFadeSlide {
          0% {
            opacity: 0;
            transform: translateY(8px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-demo-step {
          animation: demoStepFadeSlide 200ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
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

        {/* 4 Step Tabs (Real buttons with aria-selected) */}
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
                className={`relative min-h-[44px] py-2 px-2 text-xs sm:text-[13px] transition-colors flex items-center justify-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 ${
                  isActive
                    ? "text-[#2563EB] font-semibold bg-white"
                    : "text-slate-500 font-normal hover:text-slate-700 hover:bg-slate-100/60"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center transition-colors ${
                    isActive
                      ? "bg-[#2563EB] text-white"
                      : "bg-slate-200/90 text-slate-600"
                  }`}
                >
                  {t.step}
                </span>
                {/* Mobile: active tab shows label, inactive shows number only. Desktop: all show label */}
                <span className={isActive ? "inline" : "hidden sm:inline"}>
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Progress Line Under Active Tab */}
        <div
          data-testid="demo-progress-bar"
          className="w-full h-0.5 bg-slate-100 relative overflow-hidden"
        >
          <div
            className={`h-full bg-[#2563EB] ${prefersReducedMotion ? "" : "transition-all duration-300 ease-out"}`}
            style={{
              marginLeft: `${(activeStep - 1) * 25}%`,
              width: "25%",
            }}
          />
        </div>

        {/* 2-Column Desktop Body / 1-Column Mobile Body (Fixed height eliminates layout shift, CLS 0) */}
        <div className="p-4 sm:p-6 h-[300px] sm:h-[268px] overflow-hidden">
          <div
            key={activeStep}
            className={`h-full ${prefersReducedMotion ? "" : "animate-demo-step"}`}
          >
            {/* STEP 1: FIND */}
            {activeStep === 1 && (
              <div
                data-testid="demo-step-1-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 leading-snug">
                      Target unindexed roles
                    </h2>
                    <p className="text-[13px] font-normal text-slate-500 mt-0.5 leading-normal">
                      Sourced directly from employer career sites before aggregators.
                    </p>

                    {/* Role Presets */}
                    <div className="grid grid-cols-2 gap-2 mt-2.5">
                      {DEMO_ROLES.map((role) => {
                        const isSelected = role.id === currentRole.id;
                        return (
                          <button
                            key={role.id}
                            type="button"
                            data-testid={`demo-role-card-${role.id}`}
                            onClick={() => handleSelectRole(role.id)}
                            className={`px-3 py-1.5 rounded-xl text-left transition-all cursor-pointer min-h-[44px] flex flex-col justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 ${
                              isSelected
                                ? "bg-blue-50 border border-[#2563EB] text-[#2563EB]"
                                : "bg-slate-50/70 border border-slate-200/80 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                            }`}
                          >
                            <span className="text-[13px] font-semibold truncate leading-tight block">
                              {role.label}
                            </span>
                            <span className="text-[11px] font-normal text-slate-500 truncate block mt-0.5 hidden sm:block">
                              {role.coreSkills.slice(0, 2).join(" · ")}
                            </span>
                            <span className="text-[11px] font-normal text-slate-500 truncate block sm:hidden">
                              {role.coreSkills[0]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <button
                    type="button"
                    data-testid="demo-step-1-next"
                    onClick={() => handleStepClick(2)}
                    className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                  >
                    <span>See matched jobs</span>
                    <ArrowRight className="w-4 h-4 stroke-[1.75]" />
                  </button>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-700">
                        Sample unindexed opening
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="mt-2.5">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {currentJob.title}
                      </p>
                      <p className="text-[13px] font-normal text-slate-500 truncate mt-0.5">
                        {currentJob.company} · {currentJob.location}
                      </p>
                    </div>

                    <div className="mt-2.5">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-[#2563EB] border border-blue-200/80">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB]" />
                        Direct career page · Live search
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

            {/* STEP 2: MATCH */}
            {activeStep === 2 && (
              <div
                data-testid="demo-step-2-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 leading-snug">
                      Candidate match analysis
                    </h2>
                    <p className="text-[13px] font-normal text-slate-500 mt-0.5 leading-normal">
                      Grounded fit score against verified job requirements.
                    </p>

                    {/* Job Openings Selection */}
                    <div className="space-y-2 mt-2.5">
                      {currentRole.jobs.map((job) => {
                        const isSelected = job.id === currentJob.id;
                        return (
                          <button
                            key={job.id}
                            type="button"
                            data-testid={`demo-job-card-${job.id}`}
                            onClick={() => handleSelectJob(job.id)}
                            className={`w-full text-left px-3 py-1.5 rounded-xl transition-all cursor-pointer min-h-[44px] flex items-center justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 ${
                              isSelected
                                ? "bg-blue-50 border border-[#2563EB]"
                                : "bg-slate-50/70 border border-slate-200/80 hover:border-slate-300 hover:bg-slate-50"
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] font-semibold text-slate-900 truncate leading-tight">
                                {job.title}
                              </p>
                              <p className="text-[11px] font-normal text-slate-500 truncate mt-0.5">
                                {job.company}
                              </p>
                            </div>
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex-shrink-0">
                              {job.matchScore}%
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Primary Action Button */}
                  <button
                    type="button"
                    data-testid="demo-step-2-next"
                    onClick={() => handleStepClick(3)}
                    className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                  >
                    <span>Tailor resume for this role</span>
                    <ArrowRight className="w-4 h-4 stroke-[1.75]" />
                  </button>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-700">
                        Match breakdown
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {currentJob.matchScore}% match
                      </span>
                    </div>

                    {/* Match Bar */}
                    <div className="w-full h-1.5 bg-slate-200/80 rounded-full overflow-hidden mt-2.5">
                      <div
                        className="h-full bg-emerald-600 rounded-full transition-all duration-300"
                        style={{ width: `${currentJob.matchScore}%` }}
                      />
                    </div>

                    {/* Matched Skills */}
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {currentJob.matchedSkills.map((skill) => (
                        <span
                          key={skill}
                          className="px-2 py-0.5 rounded-full text-[11px] font-normal bg-emerald-50 text-emerald-700 border border-emerald-200"
                        >
                          ✓ {skill}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60">
                    <p className="text-[11px] font-normal text-slate-500">
                      Gap noted: {currentJob.missingSkill} (sample illustration)
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: TAILOR */}
            {activeStep === 3 && (
              <div
                data-testid="demo-step-3-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 leading-snug">
                      AI resume &amp; letter tuning
                    </h2>
                    <p className="text-[13px] font-normal text-slate-500 mt-0.5 leading-normal">
                      Aligns your experience to the employer stack.
                    </p>

                    {/* Document Selector Pills */}
                    <div className="inline-flex rounded-full bg-slate-100 p-0.5 border border-slate-200/80 mt-2.5">
                      <button
                        type="button"
                        data-testid="demo-doc-tab-resume"
                        onClick={() => handleDocTabChange("resume")}
                        className={`min-h-[36px] px-3 py-1 rounded-full text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
                          docTab === "resume"
                            ? "bg-white text-slate-900 font-semibold shadow-xs"
                            : "text-slate-500 font-normal hover:text-slate-700"
                        }`}
                      >
                        Resume Summary
                      </button>
                      <button
                        type="button"
                        data-testid="demo-doc-tab-cover-letter"
                        onClick={() => handleDocTabChange("coverLetter")}
                        className={`min-h-[36px] px-3 py-1 rounded-full text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
                          docTab === "coverLetter"
                            ? "bg-white text-slate-900 font-semibold shadow-xs"
                            : "text-slate-500 font-normal hover:text-slate-700"
                        }`}
                      >
                        Cover Letter
                      </button>
                    </div>

                    <p className="text-[11px] font-normal text-slate-500 mt-1.5">
                      Tailored for {currentJob.company}
                    </p>
                  </div>

                  {/* Primary Action Button */}
                  <button
                    type="button"
                    data-testid="demo-step-3-next"
                    onClick={() => handleStepClick(4)}
                    className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                  >
                    <span>Continue to apply</span>
                    <ArrowRight className="w-4 h-4 stroke-[1.75]" />
                  </button>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div
                  data-testid={
                    docTab === "resume"
                      ? "demo-resume-preview"
                      : "demo-cover-letter-preview"
                  }
                  className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]">
                        <FileText className="w-3.5 h-3.5 stroke-[1.75]" />
                        {docTab === "resume" ? "ATS-Ready Summary" : "Grounded Cover Letter"}
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <p className="text-[13px] font-normal text-slate-700 leading-relaxed mt-2 line-clamp-4">
                      {docTab === "resume"
                        ? currentJob.tailoredSummary
                        : currentJob.coverLetterExcerpt}
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

            {/* STEP 4: SEND */}
            {activeStep === 4 && (
              <div
                id="landing-demo-email-capture"
                data-testid="demo-step-4-panel"
                className="grid grid-cols-1 sm:grid-cols-12 gap-4 sm:gap-6 h-full items-stretch"
              >
                {/* Left Column: Step Content */}
                <div className="sm:col-span-6 flex flex-col justify-between h-full min-w-0">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 leading-snug">
                      Apply on official career site
                    </h2>
                    <p className="text-[13px] font-normal text-slate-500 mt-0.5 leading-normal">
                      Direct submission to the employer with zero middleman.
                    </p>

                    {/* Email Capture / Success State */}
                    <div className="mt-2">
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
                            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg text-xs font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white transition-colors"
                          >
                            <span>Continue to early access</span>
                            <ArrowRight className="w-3.5 h-3.5 stroke-[1.75]" />
                          </Link>
                        </div>
                      ) : (
                        <form
                          onSubmit={handleEmailSubmit}
                          noValidate
                          data-testid="landing-demo-email-capture"
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

                          <div className="relative">
                            <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none stroke-[1.75]" />
                            <input
                              id="landing-demo-email-input"
                              data-testid="landing-demo-email-input"
                              type="email"
                              required
                              aria-label="Email address for early access"
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
                              className="w-full pl-9 pr-3 py-2 min-h-[44px] rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                            />
                          </div>

                          {submitStatus === "error" && errorMessage && (
                            <p
                              role="alert"
                              className="text-[11px] font-normal text-red-600"
                            >
                              {errorMessage}
                            </p>
                          )}

                          <button
                            type="submit"
                            data-testid="landing-demo-email-submit"
                            disabled={submitStatus === "submitting"}
                            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl text-sm font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
                          >
                            {submitStatus === "submitting" ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin stroke-[1.75]" />
                                <span>Joining...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-4 h-4 stroke-[1.75]" />
                                <span>Get early access</span>
                                <ArrowRight className="w-4 h-4 stroke-[1.75]" />
                              </>
                            )}
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Column: Sample Result (Desktop) */}
                <div className="hidden sm:flex sm:col-span-6 flex-col justify-between h-full min-w-0 bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]">
                        <ExternalLink className="w-3.5 h-3.5 stroke-[1.75]" />
                        Official Career Site
                      </span>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="mt-2.5 space-y-1">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {currentJob.title}
                      </p>
                      <p className="text-[13px] font-normal text-slate-600">
                        You apply directly on {currentJob.company}&apos;s official career site.
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60 space-y-1">
                    <p className="flex items-center gap-1.5 text-[11px] font-normal text-slate-600">
                      <span className="text-emerald-600 font-semibold">✓</span> Sourced from company career page
                    </p>
                    <p className="flex items-center gap-1.5 text-[11px] font-normal text-slate-600">
                      <span className="text-emerald-600 font-semibold">✓</span> Direct employer ATS application
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
