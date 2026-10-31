"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Sparkles,
  FileText,
  Mail,
  ExternalLink,
  Target,
  Search,
  Clock,
  AlertCircle,
  Loader2,
  SlidersHorizontal,
  Layers,
} from "lucide-react";

const CLIENT_EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export interface DemoJobItem {
  id: string;
  title: string;
  company: string;
  monogram: string;
  location: string;
  workSetup: string;
  sourceLabel: string;
  postedAgo: string;
  matchScore: number;
  skillScore: number;
  roleScore: number;
  remoteScore: number;
  matchedSkills: string[];
  missingSkill: string;
  summary: string;
  beforeBullet: string;
  afterBullet: string;
  atsResumeHighlights: string[];
  coverLetterSnippet: string;
}

export interface DemoRoleOption {
  id: string;
  label: string;
  subtitle: string;
  candidateHeadline: string;
  coreSkills: string[];
  jobs: DemoJobItem[];
}

export const DEMO_ROLES: DemoRoleOption[] = [
  {
    id: "backend",
    label: "Backend & Systems Engineer",
    subtitle: "APIs, distributed services & relational data stores",
    candidateHeadline: "Senior Backend Engineer · Node.js, TypeScript & PostgreSQL",
    coreSkills: ["TypeScript", "Node.js", "PostgreSQL", "Docker", "REST API", "Redis"],
    jobs: [
      {
        id: "be-1",
        title: "Senior Backend Engineer — Core Platform",
        company: "Sample Infrastructure Co.",
        monogram: "SI",
        location: "Remote (Global)",
        workSetup: "Remote · Async-first",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 91,
        skillScore: 94,
        roleScore: 90,
        remoteScore: 88,
        matchedSkills: ["TypeScript", "Node.js", "PostgreSQL", "Redis", "Docker"],
        missingSkill: "Kafka",
        summary:
          "Build high-throughput ingestion services, schema migrations, and low-latency APIs powering core developer workflows.",
        beforeBullet:
          "Built backend APIs in Node.js and PostgreSQL and improved response times for user endpoints.",
        afterBullet:
          "Engineered TypeScript & Node.js ingestion APIs backed by PostgreSQL and Redis caching, cutting p95 query latency by 38% across high-volume endpoints.",
        atsResumeHighlights: [
          "Single-column ATS layout with standard section headings (Experience, Skills, Education)",
          "Aligned verified skills: TypeScript, Node.js, PostgreSQL, Redis, Docker",
          "Surfaced missing keyword note: Kafka flagged as a learning gap without fabricating experience",
        ],
        coverLetterSnippet:
          "Having architected resilient Node.js and TypeScript services backed by PostgreSQL and Redis, I focus on predictable database performance and clean API contracts. I am excited to bring this systems discipline to the Core Platform team at Sample Infrastructure Co.",
      },
      {
        id: "be-2",
        title: "Staff Distributed Systems Engineer",
        company: "Sample Cloud Telemetry Ltd.",
        monogram: "SC",
        location: "Remote (EU / India / Americas)",
        workSetup: "Remote · Flexible overlap",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 86,
        skillScore: 88,
        roleScore: 85,
        remoteScore: 85,
        matchedSkills: ["Node.js", "PostgreSQL", "Docker", "REST API"],
        missingSkill: "Kubernetes",
        summary:
          "Design fault-tolerant event pipelines and multi-region storage engines directly on the core runtime team.",
        beforeBullet:
          "Worked on containerized backend microservices and database scaling.",
        afterBullet:
          "Designed containerized Node.js microservices with Docker and partitioned PostgreSQL tables to sustain multi-tenant event workloads reliably.",
        atsResumeHighlights: [
          "Single-column ATS layout formatted for automated parser accuracy",
          "Highlighted verified distributed systems & PostgreSQL indexing bullets",
          "Zero unverified claims — Kubernetes noted separately as an optional skill gap",
        ],
        coverLetterSnippet:
          "My background centers on scaling containerized Node.js services and optimizing PostgreSQL storage under sustained production load. I would welcome the opportunity to contribute to Sample Cloud Telemetry Ltd.'s distributed runtime.",
      },
      {
        id: "be-3",
        title: "Platform API Engineer",
        company: "Sample FinTech Systems",
        monogram: "SF",
        location: "Remote (Worldwide)",
        workSetup: "Remote · Full-time",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 82,
        skillScore: 84,
        roleScore: 81,
        remoteScore: 80,
        matchedSkills: ["TypeScript", "PostgreSQL", "REST API"],
        missingSkill: "GraphQL",
        summary:
          "Own partner-facing REST endpoints, idempotency guarantees, and automated webhook delivery pipelines.",
        beforeBullet:
          "Maintained payment and webhook integrations for external API consumers.",
        afterBullet:
          "Owned idempotent TypeScript REST APIs and transactional PostgreSQL ledgers supporting reliable webhook delivery.",
        atsResumeHighlights: [
          "Clean chronological hierarchy tuned for platform engineering screens",
          "Emphasized REST API design, TypeScript type safety, and transactional SQL",
          "Preserved exact employment dates and verified titles",
        ],
        coverLetterSnippet:
          "With hands-on experience designing idempotent REST APIs in TypeScript and maintaining transactional PostgreSQL schemas, I enjoy solving reliability problems at the platform layer.",
      },
    ],
  },
  {
    id: "frontend",
    label: "Frontend & UI Engineer",
    subtitle: "React, Next.js, TypeScript & accessible design systems",
    candidateHeadline: "Senior Frontend Engineer · React, TypeScript & Next.js",
    coreSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS", "HTML5", "Accessibility"],
    jobs: [
      {
        id: "fe-1",
        title: "Senior Frontend Engineer — Design Systems",
        company: "Sample Workspace Studio",
        monogram: "SW",
        location: "Remote (Global)",
        workSetup: "Remote · Async-first",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 93,
        skillScore: 95,
        roleScore: 92,
        remoteScore: 91,
        matchedSkills: ["React", "TypeScript", "Next.js", "Tailwind CSS", "Accessibility"],
        missingSkill: "Storybook",
        summary:
          "Build accessible, keyboard-first UI primitives and high-fps interactive views across our web application.",
        beforeBullet:
          "Created reusable React components and improved page load speed across the web app.",
        afterBullet:
          "Built WCAG-compliant React and TypeScript UI primitives in Next.js and Tailwind CSS, reducing bundle payload and improving Core Web Vitals.",
        atsResumeHighlights: [
          "Single-column ATS format with clear component architecture metrics",
          "Matched core stack: React, TypeScript, Next.js, Tailwind CSS, Accessibility",
          "Storybook surfaced transparently as a gap without inventing experience",
        ],
        coverLetterSnippet:
          "Building keyboard-accessible, fast React and TypeScript interfaces in Next.js is the core of my daily work. I would love to help evolve the component architecture at Sample Workspace Studio.",
      },
      {
        id: "fe-2",
        title: "Product UI Engineer",
        company: "Sample Analytics Platform",
        monogram: "SA",
        location: "Remote (US / EU / India)",
        workSetup: "Remote · Full-time",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 87,
        skillScore: 89,
        roleScore: 86,
        remoteScore: 85,
        matchedSkills: ["React", "TypeScript", "Next.js", "HTML5"],
        missingSkill: "WebGL",
        summary:
          "Turn complex real-time datasets into responsive, intuitive product workflows and interactive dashboards.",
        beforeBullet:
          "Developed interactive dashboards and data tables in React and TypeScript.",
        afterBullet:
          "Delivered responsive React and TypeScript data exploration views in Next.js with virtualized tables and zero layout shift.",
        atsResumeHighlights: [
          "Recruiter-ready single-column structure with verified frontend impact",
          "Prioritized React state management, TypeScript, and Next.js rendering",
          "Kept factual timeline intact with zero fabricated skills",
        ],
        coverLetterSnippet:
          "I specialize in translating dense data workflows into responsive React and TypeScript interfaces. Sample Analytics Platform's focus on clarity and speed strongly aligns with my engineering approach.",
      },
    ],
  },
  {
    id: "data",
    label: "Data & ML Engineer",
    subtitle: "Python, SQL pipelines, evaluation & analytics engineering",
    candidateHeadline: "Data & ML Engineer · Python, SQL & Data Pipelines",
    coreSkills: ["Python", "SQL", "PostgreSQL", "Data Pipelines", "Docker", "Git"],
    jobs: [
      {
        id: "da-1",
        title: "Senior Data Platform Engineer",
        company: "Sample Data Grid Inc.",
        monogram: "SD",
        location: "Remote (Worldwide)",
        workSetup: "Remote · Async-first",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 89,
        skillScore: 91,
        roleScore: 88,
        remoteScore: 87,
        matchedSkills: ["Python", "SQL", "PostgreSQL", "Data Pipelines", "Docker"],
        missingSkill: "Airflow",
        summary:
          "Architect reliable batch and streaming ETL pipelines, data quality gates, and warehouse models.",
        beforeBullet:
          "Wrote Python and SQL scripts to process daily analytics data for product teams.",
        afterBullet:
          "Engineered automated Python and SQL data pipelines on PostgreSQL with schema validation gates, eliminating downstream reporting drift.",
        atsResumeHighlights: [
          "Single-column ATS layout highlighting Python, SQL, and pipeline reliability",
          "Verified keywords matched directly against role requirements",
          "Airflow flagged cleanly as an unverified skill gap",
        ],
        coverLetterSnippet:
          "With deep experience building validated Python and SQL data pipelines on PostgreSQL, I focus on data lineage and reproducibility. I am eager to support Sample Data Grid Inc.'s platform reliability.",
      },
      {
        id: "da-2",
        title: "Applied ML & Evaluation Engineer",
        company: "Sample AI Research Lab",
        monogram: "SR",
        location: "Remote (Global)",
        workSetup: "Remote · Full-time",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 84,
        skillScore: 86,
        roleScore: 83,
        remoteScore: 83,
        matchedSkills: ["Python", "SQL", "Docker", "Git"],
        missingSkill: "PyTorch",
        summary:
          "Build deterministic evaluation harnesses, dataset curation pipelines, and latency benchmarks for production models.",
        beforeBullet:
          "Built evaluation scripts in Python and tracked model quality metrics.",
        afterBullet:
          "Developed reproducible Python evaluation pipelines and SQL benchmark datasets in Dockerized environments to measure regression rates.",
        atsResumeHighlights: [
          "Structured single-column resume emphasizing Python & SQL evaluation tooling",
          "Clear separation of verified skills vs. role-specific gaps",
          "Formatted for clean ATS ingestion without multi-column tables",
        ],
        coverLetterSnippet:
          "My work focuses on rigorous Python data pipelines and deterministic evaluation harnesses. I would be excited to help scale evaluation infrastructure at Sample AI Research Lab.",
      },
    ],
  },
  {
    id: "design",
    label: "Product Designer",
    subtitle: "End-to-end product flows, systems thinking & prototyping",
    candidateHeadline: "Senior Product Designer · Design Systems & Web Apps",
    coreSkills: ["Product Design", "Design Systems", "Prototyping", "User Flows", "Accessibility"],
    jobs: [
      {
        id: "de-1",
        title: "Staff Product Designer — Core Workflows",
        company: "Sample Collaborative Tools",
        monogram: "CT",
        location: "Remote (Global)",
        workSetup: "Remote · Async-first",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 90,
        skillScore: 92,
        roleScore: 89,
        remoteScore: 89,
        matchedSkills: ["Product Design", "Design Systems", "Prototyping", "Accessibility"],
        missingSkill: "Motion Design",
        summary:
          "Lead end-to-end interaction design, shared component tokens, and high-clarity user workflows.",
        beforeBullet:
          "Designed web application screens and maintained the team component library.",
        afterBullet:
          "Led end-to-end Product Design and accessible Design Systems architecture across core web workflows, shipping interactive prototypes with engineering.",
        atsResumeHighlights: [
          "Single-column ATS layout tailored for product design leadership reviews",
          "Highlighted Design Systems, Prototyping, and Accessibility alignment",
          "Motion Design noted transparently as an optional gap",
        ],
        coverLetterSnippet:
          "I bridge systems thinking and practical interaction design, partnering closely with engineers from prototype to production. I would love to bring this craft to Sample Collaborative Tools.",
      },
      {
        id: "de-2",
        title: "Senior Systems Designer",
        company: "Sample Developer Platform",
        monogram: "DP",
        location: "Remote (Worldwide)",
        workSetup: "Remote · Full-time",
        sourceLabel: "Direct Career Page",
        postedAgo: "Posted recently",
        matchScore: 85,
        skillScore: 87,
        roleScore: 84,
        remoteScore: 84,
        matchedSkills: ["Design Systems", "User Flows", "Accessibility"],
        missingSkill: "CLI UX",
        summary:
          "Define multi-surface design tokens, documentation patterns, and developer-first workflow ergonomics.",
        beforeBullet:
          "Created design tokens and UX documentation for developer tools.",
        afterBullet:
          "Established cross-platform Design Systems tokens and accessible user flows that streamlined developer onboarding and reduced UI inconsistency.",
        atsResumeHighlights: [
          "Clean ATS typography hierarchy with verified design systems outcomes",
          "Matched core requirements without fabricating CLI UX credentials",
          "Ready for instant DOCX or plain-text export",
        ],
        coverLetterSnippet:
          "Designing coherent systems and accessible user flows for technical products is where I do my best work. I am excited by the mission at Sample Developer Platform.",
      },
    ],
  },
];

const STEPS = [
  { number: 1, title: "Pick a role" },
  { number: 2, title: "Matched jobs & scores" },
  { number: 3, title: "Open job & fit" },
  { number: 4, title: "Tailored resume & letter" },
] as const;

export function IllustrationSampleBadge({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="illustration-sample-badge"
      className={`inline-flex w-fit self-start items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200/90 leading-tight ${className}`}
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

  // Shared inline email capture state (leads directly into existing early-access flow)
  const [captureOpen, setCaptureOpen] = useState<boolean>(false);
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
    setCaptureOpen(true);
    setTimeout(() => {
      const el = document.getElementById("landing-demo-email-capture");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      const inputEl = document.getElementById("landing-demo-email-input");
      if (inputEl) {
        inputEl.focus();
      }
    }, 60);
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

      if (res.status === 429) {
        setSubmitStatus("error");
        setErrorMessage(
          data?.error || "Too many attempts. Please wait a minute and try again."
        );
        return;
      }

      if (!res.ok || data?.ok === false) {
        setSubmitStatus("error");
        setErrorMessage(
          data?.error || "Could not join the list right now. Please try again."
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
    <section
      id="interactive-product-demo"
      data-testid="landing-interactive-demo-section"
      aria-labelledby="interactive-demo-heading"
      className="py-16 sm:py-20 lg:py-24 bg-gradient-to-b from-white via-[#F8FAFC] to-white border-t border-[#E4E4E7]"
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-blue-50 text-[#2563EB] border border-blue-200/80">
            <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Interactive Product Walkthrough</span>
          </div>
          <h2
            id="interactive-demo-heading"
            className="text-3xl sm:text-4xl md:text-[40px] md:leading-[1.2] font-bold text-[#09090B] tracking-tight mt-3"
          >
            See how CareerMonke works in 4 steps
          </h2>
          <p className="mt-3 text-sm sm:text-base text-slate-600 leading-relaxed">
            Click through a sample walkthrough: pick a role, inspect matched career-page openings with fit scores, and preview how your resume and cover letter get tuned before you apply on the company&apos;s own site.
          </p>
        </div>

        {/* Live vs Coming Soon Feature Bar */}
        <div className="mb-6 flex flex-wrap items-center justify-center gap-2 sm:gap-2.5">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>Direct Career-Page Search · Live</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>Personalised Match Scores · Live</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>Resume &amp; Cover Letter Tailoring · Live</span>
          </span>
          <span
            data-testid="badge-autofill-coming-soon"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200"
          >
            <Clock className="w-3 h-3 text-amber-600" />
            <span>Autofill Extension · Coming soon</span>
          </span>
          <span
            data-testid="badge-interview-prep-coming-soon"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200"
          >
            <Clock className="w-3 h-3 text-amber-600" />
            <span>AI Interview Prep · Coming soon</span>
          </span>
        </div>

        {/* Main Interactive Demo Card */}
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-lg overflow-hidden">
          {/* Top Stepper Bar */}
          <div className="bg-[#F8FAFC] border-b border-[#E2E8F0] px-4 py-3.5 sm:px-6 sm:py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div
                role="tablist"
                aria-label="Walkthrough steps"
                className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2"
              >
                {STEPS.map((s) => {
                  const isCurrent = activeStep === s.number;
                  const isCompleted = activeStep > s.number;
                  return (
                    <button
                      key={s.number}
                      type="button"
                      role="tab"
                      aria-selected={isCurrent}
                      data-testid={`demo-step-tab-${s.number}`}
                      onClick={() => setActiveStep(s.number)}
                      className={`inline-flex items-center gap-2 px-3 py-2 min-h-[40px] rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer text-left ${
                        isCurrent
                          ? "bg-[#2563EB] text-white shadow-xs"
                          : isCompleted
                          ? "bg-blue-50 text-[#1D4ED8] border border-blue-200 hover:bg-blue-100/70"
                          : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <span
                        className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 ${
                          isCurrent
                            ? "bg-white text-[#2563EB]"
                            : isCompleted
                            ? "bg-[#2563EB] text-white"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {isCompleted ? "✓" : s.number}
                      </span>
                      <span className="truncate">{s.title}</span>
                    </button>
                  );
                })}
              </div>

              <IllustrationSampleBadge className="self-start sm:self-auto shrink-0" />
            </div>
          </div>

          {/* Step Body Container */}
          <div className="p-5 sm:p-8 transition-all duration-200">
            {/* =============================================================== */}
            {/* STEP 1: PICK A ROLE                                             */}
            {/* =============================================================== */}
            {activeStep === 1 && (
              <div data-testid="demo-step-panel-1" className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                      Step 1 of 4 · Personalised Setup
                    </span>
                    <h3 className="text-xl sm:text-2xl font-bold text-[#09090B] mt-0.5">
                      Pick a role to preview your matched feed
                    </h3>
                  </div>
                  <IllustrationSampleBadge />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {DEMO_ROLES.map((role) => {
                    const isSelected = role.id === currentRole.id;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        data-testid={`demo-role-card-${role.id}`}
                        onClick={() => handleSelectRole(role.id)}
                        className={`p-4 sm:p-5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                          isSelected
                            ? "border-[#2563EB] bg-blue-50/40 ring-2 ring-[#2563EB]/20 shadow-xs"
                            : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60"
                        }`}
                      >
                        <div className="space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-base font-bold text-[#09090B]">
                              {role.label}
                            </span>
                            <span
                              className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                isSelected
                                  ? "bg-[#2563EB] text-white"
                                  : "border border-slate-300 bg-white text-transparent"
                              }`}
                            >
                              ✓
                            </span>
                          </div>
                          <p className="text-xs sm:text-sm text-slate-600">
                            {role.subtitle}
                          </p>
                        </div>

                        <div className="space-y-2 pt-2 border-t border-slate-100">
                          <div className="flex flex-wrap gap-1.5">
                            {role.coreSkills.map((skill) => (
                              <span
                                key={skill}
                                className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-white text-slate-700 border border-slate-200"
                              >
                                {skill}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[11px] text-slate-500 font-medium">
                              Sample profile preset
                            </span>
                            <IllustrationSampleBadge />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Step 1 Footer Actions */}
                <div className="pt-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="text-xs sm:text-sm text-slate-600">
                    Selected profile:{" "}
                    <span className="font-semibold text-[#09090B]">
                      {currentRole.candidateHeadline}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleOpenEmailCapture}
                      className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                    >
                      Get early access
                    </button>
                    <button
                      type="button"
                      data-testid="demo-next-to-step-2"
                      onClick={() => setActiveStep(2)}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs sm:text-sm shadow-xs transition-all cursor-pointer"
                    >
                      <span>See matched jobs</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* =============================================================== */}
            {/* STEP 2: SEE MATCHED JOBS WITH A SCORE                           */}
            {/* =============================================================== */}
            {activeStep === 2 && (
              <div data-testid="demo-step-panel-2" className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                      Step 2 of 4 · Direct Career-Page Matches
                    </span>
                    <h3 className="text-xl sm:text-2xl font-bold text-[#09090B] mt-0.5">
                      Roles ranked by your verified resume skills
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <IllustrationSampleBadge />
                  </div>
                </div>

                <div className="space-y-3.5">
                  {currentRole.jobs.map((job) => {
                    const isSelected = job.id === currentJob.id;
                    return (
                      <div
                        key={job.id}
                        data-testid={`demo-job-card-${job.id}`}
                        onClick={() => setSelectedJobId(job.id)}
                        className={`p-4 sm:p-5 rounded-xl border transition-all cursor-pointer ${
                          isSelected
                            ? "border-[#2563EB] bg-blue-50/30 ring-2 ring-[#2563EB]/15"
                            : "border-slate-200 bg-white hover:border-slate-300"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                          <div className="flex items-start gap-3.5">
                            <div
                              aria-hidden="true"
                              className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 text-slate-700 font-bold text-sm flex items-center justify-center shrink-0"
                            >
                              {job.monogram}
                            </div>
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="text-base font-bold text-[#09090B]">
                                  {job.title}
                                </h4>
                                <IllustrationSampleBadge />
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                                <span className="font-semibold text-slate-800">
                                  {job.company}
                                </span>
                                <span>·</span>
                                <span>{job.location}</span>
                                <span>·</span>
                                <span className="text-[#2563EB] font-medium">
                                  {job.sourceLabel}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Match Score Pill + Mandatory Sample Label */}
                          <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-1.5 shrink-0">
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs sm:text-sm font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <Target className="w-3.5 h-3.5 text-emerald-600" />
                              <span>{job.matchScore}% Match</span>
                            </span>
                            <IllustrationSampleBadge />
                          </div>
                        </div>

                        {/* Matched vs Missing Skill Pills */}
                        <div className="mt-3.5 pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {job.matchedSkills.map((skill) => (
                              <span
                                key={skill}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50/80 text-emerald-800 border border-emerald-200"
                              >
                                <span>✓</span>
                                <span>{skill}</span>
                              </span>
                            ))}
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                              <span>Gap: {job.missingSkill}</span>
                            </span>
                          </div>

                          <button
                            type="button"
                            data-testid={`demo-open-job-${job.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedJobId(job.id);
                              setActiveStep(3);
                            }}
                            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold text-xs transition-all cursor-pointer shrink-0"
                          >
                            <span>Open job &amp; fit</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Step 2 Footer Navigation */}
                <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveStep(1)}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Change role</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleOpenEmailCapture}
                      className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                    >
                      Get early access
                    </button>
                    <button
                      type="button"
                      data-testid="demo-next-to-step-3"
                      onClick={() => setActiveStep(3)}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs sm:text-sm shadow-xs transition-all cursor-pointer"
                    >
                      <span>Inspect selected role</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* =============================================================== */}
            {/* STEP 3: OPEN A JOB & FIT BREAKDOWN                              */}
            {/* =============================================================== */}
            {activeStep === 3 && (
              <div data-testid="demo-step-panel-3" className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                      Step 3 of 4 · Role Details &amp; Fit Diagnostics
                    </span>
                    <h3 className="text-xl sm:text-2xl font-bold text-[#09090B] mt-0.5">
                      {currentJob.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-600 mt-1">
                      <span className="font-semibold text-slate-900">
                        {currentJob.company}
                      </span>
                      <span>·</span>
                      <span>{currentJob.workSetup}</span>
                      <span>·</span>
                      <IllustrationSampleBadge />
                    </div>
                  </div>

                  <div className="flex flex-col items-start sm:items-end gap-1">
                    <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <Target className="w-4 h-4 text-emerald-600" />
                      <span>{currentJob.matchScore}% Overall Fit</span>
                    </span>
                    <IllustrationSampleBadge />
                  </div>
                </div>

                {/* Fit Breakdown Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>Skill Alignment</span>
                      <span className="text-[#2563EB]">{currentJob.skillScore}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#2563EB] rounded-full"
                        style={{ width: `${currentJob.skillScore}%` }}
                      />
                    </div>
                    <IllustrationSampleBadge />
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>Role &amp; Seniority Fit</span>
                      <span className="text-[#2563EB]">{currentJob.roleScore}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#2563EB] rounded-full"
                        style={{ width: `${currentJob.roleScore}%` }}
                      />
                    </div>
                    <IllustrationSampleBadge />
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>Remote Scope Fit</span>
                      <span className="text-[#2563EB]">{currentJob.remoteScore}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#2563EB] rounded-full"
                        style={{ width: `${currentJob.remoteScore}%` }}
                      />
                    </div>
                    <IllustrationSampleBadge />
                  </div>
                </div>

                {/* Role Summary & Direct Apply Explanation */}
                <div className="p-4 sm:p-5 rounded-xl bg-white border border-slate-200 space-y-4">
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      Role overview (from company career page)
                    </div>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {currentJob.summary}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                    <div>
                      <div className="text-xs font-semibold text-slate-700 mb-1.5">
                        Matched from your resume
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {currentJob.matchedSkills.map((skill) => (
                          <span
                            key={skill}
                            className="px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200"
                          >
                            ✓ {skill}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold text-slate-700 mb-1.5">
                        Missing keyword surfaced before you apply
                      </div>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                        Gap: {currentJob.missingSkill}
                      </span>
                    </div>
                  </div>

                  {/* Honest Direct Career Site Note + Coming Soon Badges */}
                  <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs text-slate-600">
                    <div className="flex items-center gap-1.5">
                      <ExternalLink className="w-3.5 h-3.5 text-[#2563EB] shrink-0" />
                      <span>
                        You apply directly on the company&apos;s official career site (no middleman forms).
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 font-semibold text-[11px]">
                        Autofill Extension · Coming soon
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 font-semibold text-[11px]">
                        AI Interview Prep · Coming soon
                      </span>
                    </div>
                  </div>
                </div>

                {/* Step 3 Footer Navigation */}
                <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveStep(2)}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Back to matched jobs</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleOpenEmailCapture}
                      className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                    >
                      Get early access
                    </button>
                    <button
                      type="button"
                      data-testid="demo-next-to-step-4"
                      onClick={() => setActiveStep(4)}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs sm:text-sm shadow-xs transition-all cursor-pointer"
                    >
                      <span>See tailored resume &amp; cover letter</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* =============================================================== */}
            {/* STEP 4: TAILORED RESUME & COVER LETTER + UNIFIED CTA            */}
            {/* =============================================================== */}
            {activeStep === 4 && (
              <div data-testid="demo-step-panel-4" className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                      Step 4 of 4 · Grounded AI Tailoring
                    </span>
                    <h3 className="text-xl sm:text-2xl font-bold text-[#09090B] mt-0.5">
                      Tailored resume &amp; cover letter for {currentJob.title}
                    </h3>
                    <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
                      Tuned to {currentJob.company} using only your verified resume facts — zero fabricated employers or skills.
                    </p>
                  </div>
                  <IllustrationSampleBadge />
                </div>

                {/* Toggle between Tailored Resume and Cover Letter */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="demo-doc-tab-resume"
                    onClick={() => setDocTab("resume")}
                    className={`inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                      docTab === "resume"
                        ? "bg-[#2563EB] text-white shadow-xs"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200/70"
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <span>Tailored ATS Resume</span>
                  </button>
                  <button
                    type="button"
                    data-testid="demo-doc-tab-cover-letter"
                    onClick={() => setDocTab("coverLetter")}
                    className={`inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                      docTab === "coverLetter"
                        ? "bg-[#2563EB] text-white shadow-xs"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200/70"
                    }`}
                  >
                    <Mail className="w-4 h-4" />
                    <span>Grounded Cover Letter</span>
                  </button>
                </div>

                {docTab === "resume" ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Original Bullet */}
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                            Original resume bullet
                          </span>
                          <IllustrationSampleBadge />
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed">
                          &ldquo;{currentJob.beforeBullet}&rdquo;
                        </p>
                      </div>

                      {/* Tailored ATS Bullet */}
                      <div className="p-4 rounded-xl bg-blue-50/50 border border-blue-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                            AI-refined ATS bullet
                          </span>
                          <IllustrationSampleBadge />
                        </div>
                        <p className="text-sm text-[#09090B] font-medium leading-relaxed">
                          &ldquo;{currentJob.afterBullet}&rdquo;
                        </p>
                      </div>
                    </div>

                    {/* ATS Single-Column Checklist */}
                    <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                          Single-column ATS export checks
                        </span>
                        <IllustrationSampleBadge />
                      </div>
                      <ul className="space-y-2">
                        {currentJob.atsResumeHighlights.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-xs sm:text-sm text-slate-700">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200/80">
                      <div className="text-xs font-bold text-slate-700">
                        Role-Specific Cover Letter Preview · {currentJob.title} ({currentJob.company})
                      </div>
                      <IllustrationSampleBadge />
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed">
                      {currentJob.coverLetterSnippet}
                    </p>
                    <p className="text-xs text-slate-500">
                      Generated strictly from your confirmed resume profile so you can download and submit it on the company&apos;s career page.
                    </p>
                  </div>
                )}

                {/* Step 4 CTA Banner */}
                <div className="p-5 sm:p-6 rounded-2xl bg-[#2563EB] text-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h4 className="text-lg sm:text-xl font-bold">
                      Ready to try this with your own resume?
                    </h4>
                    <p className="text-xs sm:text-sm text-white/90">
                      Join early access to unlock direct career-page search, match scores, and AI resume tailoring.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setActiveStep(3)}
                      className="px-4 py-2.5 min-h-[44px] rounded-xl bg-blue-700 hover:bg-blue-800 text-white border border-white/30 font-semibold text-xs sm:text-sm transition-all cursor-pointer"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      data-testid="demo-primary-cta"
                      onClick={handleOpenEmailCapture}
                      className="inline-flex items-center justify-center gap-2 px-6 py-3 min-h-[44px] rounded-xl bg-white text-[#09090B] hover:bg-slate-100 font-bold text-xs sm:text-sm shadow-md transition-all cursor-pointer"
                    >
                      <span>Join early access</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ================================================================= */}
          {/* SHARED INLINE EMAIL CAPTURE -> EXISTING EARLY-ACCESS FLOW         */}
          {/* ================================================================= */}
          {captureOpen && (
            <div
              id="landing-demo-email-capture"
              data-testid="landing-demo-email-capture"
              className="border-t border-blue-100 bg-[#F0F7FF] px-5 py-6 sm:px-8 sm:py-7"
            >
              <div className="max-w-xl mx-auto space-y-4">
                {submitStatus === "success" ? (
                  <div
                    role="status"
                    aria-live="polite"
                    data-testid="landing-demo-email-success"
                    className="p-5 rounded-xl bg-white border border-emerald-200 shadow-xs space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-base font-bold text-[#09090B]">
                          You&apos;re on the early-access list
                        </h4>
                        <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                          We&apos;ve reserved your spot for{" "}
                          <span className="font-semibold text-[#09090B]">
                            {email.trim().toLowerCase()}
                          </span>
                          . Continue to the early-access page for full status and sign-in details.
                        </p>
                      </div>
                    </div>
                    <div className="pt-1 flex flex-wrap items-center gap-3">
                      <Link
                        href="/early-access"
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[42px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs sm:text-sm transition-all"
                      >
                        <span>Continue to early-access page</span>
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </div>
                  </div>
                ) : (
                  <form
                    onSubmit={handleEmailSubmit}
                    noValidate
                    aria-label="Interactive demo early access email capture"
                    className="space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h4 className="text-base sm:text-lg font-bold text-[#09090B]">
                          Reserve your early-access invite
                        </h4>
                        <p className="text-xs sm:text-sm text-slate-600">
                          Enter your email to join the waitlist and unlock CareerMonke when your batch opens.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCaptureOpen(false)}
                        className="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-1 rounded-md cursor-pointer"
                      >
                        Close
                      </button>
                    </div>

                    {/* Honeypot field */}
                    <div
                      className="absolute -left-[9999px] w-px h-px overflow-hidden opacity-0 pointer-events-none"
                      aria-hidden="true"
                    >
                      <label htmlFor="landing-demo-website">Website</label>
                      <input
                        id="landing-demo-website"
                        name="website"
                        type="text"
                        tabIndex={-1}
                        autoComplete="off"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <div className="flex-1">
                        <label htmlFor="landing-demo-email-input" className="sr-only">
                          Email address
                        </label>
                        <input
                          id="landing-demo-email-input"
                          name="email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          required
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            if (submitStatus === "error") {
                              setSubmitStatus("idle");
                              setErrorMessage("");
                            }
                          }}
                          placeholder="Enter your email address"
                          aria-invalid={submitStatus === "error"}
                          className="w-full h-11 min-h-[44px] px-4 rounded-xl bg-white border border-slate-300 text-[#09090B] placeholder-slate-400 text-sm focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD]"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={submitStatus === "submitting"}
                        className="h-11 min-h-[44px] px-6 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm inline-flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-60 shrink-0"
                      >
                        {submitStatus === "submitting" ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Joining…</span>
                          </>
                        ) : (
                          <>
                            <span>Join early access</span>
                            <ArrowRight className="w-4 h-4" />
                          </>
                        )}
                      </button>
                    </div>

                    {submitStatus === "error" && errorMessage && (
                      <div
                        role="alert"
                        className="p-3 rounded-xl bg-red-50 border border-red-200 flex items-center gap-2 text-xs sm:text-sm text-red-700"
                      >
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                        <span>{errorMessage}</span>
                      </div>
                    )}
                  </form>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
