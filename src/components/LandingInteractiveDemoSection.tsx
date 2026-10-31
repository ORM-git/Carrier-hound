"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Sparkles,
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
    label: "Backend & Systems Engineer",
    subtitle: "TypeScript · Node.js · PostgreSQL · Docker",
    coreSkills: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
    jobs: [
      {
        id: "be-1",
        title: "Senior Backend Engineer — Core Platform",
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
        title: "Distributed Systems Engineer (Node/TS)",
        company: "Sample Payments Infra",
        monogram: "SP",
        location: "Remote (US / EU / India)",
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
    label: "Frontend & UI Engineer",
    subtitle: "React · Next.js · TypeScript · Tailwind CSS",
    coreSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS"],
    jobs: [
      {
        id: "fe-1",
        title: "Senior Frontend Engineer — Design Systems",
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
        title: "Product UI Engineer (React / Next.js)",
        company: "Sample Analytics Hub",
        monogram: "SA",
        location: "Remote (Americas & Europe)",
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
    label: "Data & ML Engineer",
    subtitle: "Python · SQL · PostgreSQL · Data Pipelines",
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
        title: "Applied ML Infrastructure Engineer",
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
    label: "Product Designer",
    subtitle: "Product Design · Design Systems · Prototyping",
    coreSkills: ["Product Design", "Design Systems", "Prototyping", "Accessibility"],
    jobs: [
      {
        id: "pd-1",
        title: "Staff Product Designer — Core Workflows",
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
        location: "Remote (US / EU / APAC)",
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
      className={`inline-flex w-fit self-start items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200/90 leading-tight ${className}`}
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

  // Shared inline email capture state inside Step 4 ("Send")
  const [email, setEmail] = useState<string>("");
  const [website, setWebsite] = useState<string>(""); // Honeypot
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const currentRole =
    DEMO_ROLES.find((r) => r.id === selectedRoleId) || DEMO_ROLES[0];
  const currentJob =
    currentRole.jobs.find((j) => j.id === selectedJobId) || currentRole.jobs[0];

  const handleSelectRole = (roleId: string) => {
    const found = DEMO_ROLES.find((r) => r.id === roleId) || DEMO_ROLES[0];
    setSelectedRoleId(found.id);
    setSelectedJobId(found.jobs[0].id);
  };

  const handleOpenEmailCapture = () => {
    setActiveStep(4);
    setTimeout(() => {
      const inputEl = document.getElementById("landing-demo-email-input");
      if (inputEl) {
        inputEl.focus();
      }
    }, 50);
  };

  const handlePrimaryCardAction = () => {
    if (activeStep === 1) {
      setActiveStep(2);
    } else if (activeStep === 2) {
      setActiveStep(3);
    } else if (activeStep === 3) {
      handleOpenEmailCapture();
    }
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

  const progressPercent = activeStep * 25;

  return (
    <section
      id="interactive-product-demo"
      data-testid="landing-interactive-demo-section"
      aria-labelledby="interactive-demo-heading"
      className="py-12 sm:py-16 bg-[#F8FAFC] border-t border-[#E4E4E7]"
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 items-center gap-8 lg:gap-10">
          {/* Left Side (Desktop) / Top (Mobile): Short Heading + One Line of Text + Feature Badges */}
          <div className="lg:col-span-6 space-y-4 text-center lg:text-left">
            <h2
              id="interactive-demo-heading"
              className="text-2xl sm:text-3xl md:text-[34px] font-bold tracking-tight text-[#09090B] leading-tight"
            >
              From hidden role to tailored resume in four steps.
            </h2>
            <p className="text-sm sm:text-base text-[#4B5563] leading-relaxed max-w-lg mx-auto lg:mx-0">
              Pick a role, check your match score, and preview a tailored resume before applying on the company&apos;s own career page.
            </p>

            {/* Live vs Coming Soon feature badges */}
            <div
              data-testid="demo-feature-status-bar"
              className="flex flex-wrap items-center justify-center lg:justify-start gap-2 pt-1"
            >
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Direct Career-Page Search · Live
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Personalised Match Scores · Live
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Resume &amp; Cover Letter Tailoring · Live
              </span>
              <span
                data-testid="coming-soon-autofill"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200"
              >
                <Clock className="w-3 h-3 text-amber-600" />
                Autofill Extension · Coming soon
              </span>
              <span
                data-testid="coming-soon-interview-prep"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200"
              >
                <Clock className="w-3 h-3 text-amber-600" />
                AI Interview Prep · Coming soon
              </span>
            </div>
          </div>

          {/* Right Side (Desktop) / Bottom (Mobile): Compact Browser-Style Card (420-480px on desktop, full width on mobile) */}
          <div className="lg:col-span-6 w-full max-w-[460px] mx-auto lg:mr-0">
            <div
              data-testid="compact-browser-demo-card"
              className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden"
            >
              {/* Browser top bar */}
              <div className="px-3.5 py-2.5 bg-slate-50 border-b border-[#E2E8F0] flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
                  <span className="ml-1.5 text-[11px] font-medium text-slate-500">
                    careermonke.com
                  </span>
                </div>
                <IllustrationSampleBadge />
              </div>

              {/* 4 Step Tabs: Find, Match, Tailor, Send */}
              <div
                role="tablist"
                aria-label="Interactive walkthrough steps"
                className="grid grid-cols-4 bg-white border-b border-slate-100"
              >
                {STEP_TABS.map((t) => {
                  const isActive = activeStep === t.step;
                  const isCompleted = activeStep > t.step;
                  return (
                    <button
                      key={t.step}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-testid={`demo-step-tab-${t.step}`}
                      onClick={() => setActiveStep(t.step)}
                      className={`py-2.5 px-2 text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                        isActive
                          ? "text-[#2563EB] bg-blue-50/50"
                          : isCompleted
                          ? "text-slate-700 hover:bg-slate-50"
                          : "text-slate-400 hover:text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center ${
                          isActive
                            ? "bg-[#2563EB] text-white"
                            : isCompleted
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {isCompleted ? <Check className="w-2.5 h-2.5 stroke-[3]" /> : t.step}
                      </span>
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Progress Bar */}
              <div
                data-testid="demo-progress-bar"
                className="w-full h-1 bg-slate-100 overflow-hidden"
              >
                <div
                  className="h-full bg-[#2563EB] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              {/* Compact Step Body */}
              <div className="p-4 sm:p-5">
                {/* STEP 1: FIND */}
                {activeStep === 1 && (
                  <div data-testid="demo-step-1-panel" className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-[#09090B]">
                        What role are you targeting?
                      </p>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="space-y-2">
                      {DEMO_ROLES.map((role) => {
                        const isSelected = role.id === currentRole.id;
                        return (
                          <button
                            key={role.id}
                            type="button"
                            data-testid={`demo-role-card-${role.id}`}
                            onClick={() => handleSelectRole(role.id)}
                            className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                              isSelected
                                ? "border-[#2563EB] bg-blue-50/40 ring-1 ring-[#2563EB]/20"
                                : "border-slate-200 bg-white hover:border-slate-300"
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs sm:text-sm font-bold text-[#09090B] truncate">
                                {role.label}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {role.subtitle}
                              </div>
                            </div>
                            <span
                              className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${
                                isSelected
                                  ? "bg-[#2563EB] text-white"
                                  : "border border-slate-300"
                              }`}
                            >
                              {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      data-testid="demo-step-1-next"
                      onClick={handlePrimaryCardAction}
                      className="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-all cursor-pointer"
                    >
                      <span>See matched jobs</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* STEP 2: MATCH */}
                {activeStep === 2 && (
                  <div data-testid="demo-step-2-panel" className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-[#09090B]">
                        Matched openings for {currentRole.label}
                      </p>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="space-y-2">
                      {currentRole.jobs.map((job) => {
                        const isSelected = job.id === currentJob.id;
                        return (
                          <button
                            key={job.id}
                            type="button"
                            data-testid={`demo-job-card-${job.id}`}
                            onClick={() => setSelectedJobId(job.id)}
                            className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${
                              isSelected
                                ? "border-[#2563EB] bg-blue-50/40 ring-1 ring-[#2563EB]/20"
                                : "border-slate-200 bg-white hover:border-slate-300"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-slate-900 text-white font-bold text-xs flex items-center justify-center flex-shrink-0">
                                  {job.monogram}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-xs sm:text-sm font-bold text-[#09090B] truncate">
                                    {job.title}
                                  </div>
                                  <div className="text-[11px] text-slate-500 truncate">
                                    {job.company} · {job.location}
                                  </div>
                                </div>
                              </div>
                              <span className="px-2 py-0.5 rounded-full text-xs font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200 flex-shrink-0">
                                {job.matchScore}% match
                              </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <span className="text-[11px] text-slate-500">
                                Matched: {job.matchedSkills.slice(0, 3).join(", ")}
                              </span>
                              <IllustrationSampleBadge />
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      data-testid="demo-step-2-next"
                      onClick={handlePrimaryCardAction}
                      className="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-all cursor-pointer"
                    >
                      <span>Tailor resume for this role</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* STEP 3: TAILOR */}
                {activeStep === 3 && (
                  <div data-testid="demo-step-3-panel" className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-[#09090B]">
                        Tailored for {currentJob.company}
                      </p>
                      <div className="inline-flex rounded-lg bg-slate-100 p-0.5 border border-slate-200">
                        <button
                          type="button"
                          data-testid="demo-doc-tab-resume"
                          onClick={() => setDocTab("resume")}
                          className={`px-2 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                            docTab === "resume"
                              ? "bg-white text-[#09090B] shadow-2xs"
                              : "text-slate-600"
                          }`}
                        >
                          Resume
                        </button>
                        <button
                          type="button"
                          data-testid="demo-doc-tab-cover-letter"
                          onClick={() => setDocTab("coverLetter")}
                          className={`px-2 py-1 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                            docTab === "coverLetter"
                              ? "bg-white text-[#09090B] shadow-2xs"
                              : "text-slate-600"
                          }`}
                        >
                          Cover Letter
                        </button>
                      </div>
                    </div>

                    <div
                      data-testid={
                        docTab === "resume"
                          ? "demo-resume-preview"
                          : "demo-cover-letter-preview"
                      }
                      className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#2563EB]">
                          <FileText className="w-3.5 h-3.5" />
                          {docTab === "resume"
                            ? "ATS-Ready Summary"
                            : "Grounded Cover Letter"}
                        </span>
                        <IllustrationSampleBadge />
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed">
                        {docTab === "resume"
                          ? currentJob.tailoredSummary
                          : currentJob.coverLetterExcerpt}
                      </p>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {currentJob.matchedSkills.map((skill) => (
                          <span
                            key={skill}
                            className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200"
                          >
                            ✓ {skill}
                          </span>
                        ))}
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                          Gap noted: {currentJob.missingSkill}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid="demo-step-3-next"
                      onClick={handlePrimaryCardAction}
                      className="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-all cursor-pointer"
                    >
                      <span>Continue to apply</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* STEP 4: SEND (Direct Employer Career Site + Inline Email Capture -> Early-Access Flow) */}
                {activeStep === 4 && (
                  <div
                    id="landing-demo-email-capture"
                    data-testid="demo-step-4-panel"
                    className="space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-[#09090B]">
                        Apply on the company&apos;s career site
                      </p>
                      <IllustrationSampleBadge />
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#09090B] truncate">
                          {currentJob.title}
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <ExternalLink className="w-3 h-3 text-[#2563EB] flex-shrink-0" />
                          <span className="truncate">
                            You apply directly on {currentJob.company}&apos;s official career site
                          </span>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-xs font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200 flex-shrink-0">
                        {currentJob.matchScore}%
                      </span>
                    </div>

                    {submitStatus === "success" ? (
                      <div
                        data-testid="landing-demo-email-success"
                        className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2"
                      >
                        <div className="flex items-center gap-2 text-emerald-900 font-bold text-xs">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                          <span>You&apos;re on the early-access list!</span>
                        </div>
                        <Link
                          href="/early-access"
                          className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white transition-all"
                        >
                          <span>Continue to early-access page</span>
                          <ArrowRight className="w-3.5 h-3.5" />
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
                          <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
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
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-[#09090B] placeholder:text-slate-400 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                          />
                        </div>

                        {submitStatus === "error" && errorMessage && (
                          <p
                            role="alert"
                            className="text-[11px] font-medium text-red-600"
                          >
                            {errorMessage}
                          </p>
                        )}

                        <button
                          type="submit"
                          data-testid="landing-demo-email-submit"
                          disabled={submitStatus === "submitting"}
                          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-all cursor-pointer disabled:opacity-60"
                        >
                          {submitStatus === "submitting" ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Joining...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>Get early access</span>
                              <ArrowRight className="w-4 h-4" />
                            </>
                          )}
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Required caption directly under the card */}
            <p
              data-testid="illustration-card-caption"
              className="mt-2.5 text-center lg:text-right text-[11px] font-medium text-slate-500"
            >
              Illustration - sample companies and scores
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
