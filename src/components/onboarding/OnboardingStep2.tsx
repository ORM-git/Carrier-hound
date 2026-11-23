"use client";

import React, { useEffect, useRef, useState } from "react";
import BrandIcon from "@/components/BrandIcon";
import { ArrowLeft, FileText, CheckCircle2, AlertCircle, Upload, Loader2, Check, FileCheck, LogOut } from "lucide-react";
import { toast } from "react-toastify";
import { isOnboardingStep2EnabledClient } from "@/config/onboarding";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";
import { MAX_RESUME_SIZE_BYTES, RESUME_MIME } from "@/lib/onboarding/step2Resume";
import OnboardingProcessingScreen from "./OnboardingProcessingScreen";

interface OnboardingStep2Props {
  onBack: () => void;
  onFinish: () => void;
  isSaving: boolean;
  authToken?: string;
  onLogout?: () => void;
  initialResumeName?: string | null;
  initialResumeParse?: ResumeParseSummary | null;
  initialUploading?: boolean;
  onResumeSaved?: (fileName: string, parse: ResumeParseSummary | null) => void;
  initialLinkedinUrl?: string | null;
  onLinkedinSaved?: (url: string) => void;
  initialResumeFile?: File | null;
  onResumeFileSaved?: (file: File) => void;
}

const ACCEPT = `.pdf,.docx,${RESUME_MIME.pdf},${RESUME_MIME.docx}`;

/** `parse` from POST /api/onboarding/resume (summary of the user's own parsed profile). */
export interface ResumeParseSummary {
  status: "parsed" | "failed" | "unavailable";
  reason?: "no_text" | "scanned_pdf" | "parse_error" | null;
  source?: string | null;
  jobTitle?: string | null;
  skillsCount?: number;
  topSkills?: string[];
  yearsOfExperience?: number | null;
}

/** One line under "Resume saved" describing what we read. Exported for tests. */
export function describeResumeParse(p: ResumeParseSummary | null | undefined): string | null {
  if (!p) return null;
  if (p.status === "parsed") {
    const bits: string[] = [];
    if (p.jobTitle) bits.push(p.jobTitle);
    if (p.skillsCount) bits.push(`${p.skillsCount} skill${p.skillsCount === 1 ? "" : "s"}`);
    if (typeof p.yearsOfExperience === "number" && p.yearsOfExperience > 0) {
      bits.push(`${p.yearsOfExperience} yrs experience`);
    }
    return bits.length > 0
      ? `We read ${bits.join(" · ")}. We'll use this to rank your recommended jobs.`
      : "We'll use your resume to rank your recommended jobs.";
  }
  if (p.status === "failed") {
    return p.reason === "scanned_pdf"
      ? "We couldn't read text from this file (it looks like a scanned image). You can continue; recommendations will use your preferences."
      : "We couldn't read details from this file. You can continue; recommendations will use your preferences.";
  }
  return null;
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

function SkipLink({ onClick, label, testId }: { onClick: () => void; label: string; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-label={label}
      className="text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline underline-offset-2"
    >
      Skip
    </button>
  );
}

export default function OnboardingStep2({
  onBack,
  onFinish,
  isSaving,
  authToken,
  onLogout,
  initialResumeName = null,
  initialResumeParse = null,
  initialUploading = false,
  onResumeSaved,
  initialLinkedinUrl = null,
  onLinkedinSaved,
  initialResumeFile = null,
  onResumeFileSaved,
}: OnboardingStep2Props) {
  const isFeatureEnabled = isOnboardingStep2EnabledClient();

  const [linkedinInput, setLinkedinInput] = useState(initialLinkedinUrl ?? "");
  const [linkedinSaved, setLinkedinSaved] = useState(Boolean(initialLinkedinUrl));
  const [linkedinEverSaved, setLinkedinEverSaved] = useState(Boolean(initialLinkedinUrl));
  const [showLinkedinHelp, setShowLinkedinHelp] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(initialResumeFile);
  const [linkedinSkipped, setLinkedinSkipped] = useState(false);
  const [linkedinSaving, setLinkedinSaving] = useState(false);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);

  const [resumeName, setResumeName] = useState<string | null>(initialResumeName);
  const [resumeParse, setResumeParse] = useState<ResumeParseSummary | null>(initialResumeParse);
  const [resumeSkipped, setResumeSkipped] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(initialUploading);
  const [pendingUploadName, setPendingUploadName] = useState<string | null>(
    initialUploading ? (initialResumeName || "Alex_Morgan_Resume_2026.pdf") : null
  );
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mobileFileInputRef = useRef<HTMLInputElement>(null);
  const activeUploadRef = useRef<number>(0);

  const handleSaveLinkedIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateAndNormalizeLinkedInUrl(linkedinInput);
    if (!check.valid || !check.normalizedUrl) {
      setLinkedinError(check.error || "Invalid LinkedIn URL.");
      return;
    }
    if (!authToken) {
      setLinkedinError("Your session expired. Please sign in again, or skip for now.");
      return;
    }
    setLinkedinSaving(true);
    setLinkedinError(null);
    try {
      const res = await fetch("/api/onboarding/linkedin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ linkedinUrl: check.normalizedUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Couldn't save your LinkedIn URL.");
      const savedUrl = data.linkedinUrl || check.normalizedUrl;
      setLinkedinInput(savedUrl);
      setLinkedinSaved(true);
      setLinkedinEverSaved(true);
      onLinkedinSaved?.(savedUrl);
      toast.success("LinkedIn URL saved");
    } catch (err: any) {
      setLinkedinError(err?.message || "Couldn't save your LinkedIn URL.");
    } finally {
      setLinkedinSaving(false);
    }
  };

  const uploadResume = async (file: File) => {
    setResumeError(null);
    const ext = file.name.toLowerCase().split(".").pop();
    if (!(ext === "pdf" || ext === "docx")) {
      setResumeError("Please upload a PDF or DOCX file.");
      return;
    }
    if (file.size === 0 || file.size > MAX_RESUME_SIZE_BYTES) {
      setResumeError(file.size === 0 ? "That file is empty." : "Resume must be 5 MB or smaller.");
      return;
    }
    if (!authToken) {
      setResumeError("Your session expired. Please sign in again, or skip for now.");
      return;
    }

    // Concurrency & stale response guard
    const reqId = ++activeUploadRef.current;
    setPendingUploadName(file.name);
    setResumeUploading(true);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/onboarding/resume", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });

      // Discard if newer upload was initiated
      if (reqId !== activeUploadRef.current) return;

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Couldn't upload your resume.");

      const finalName = data.fileName || file.name;
      const finalParse = data?.parse && typeof data.parse === "object" ? (data.parse as ResumeParseSummary) : null;
      setResumeName(finalName);
      setResumeParse(finalParse);
      onResumeSaved?.(finalName, finalParse);
      setResumeFile(file);
      onResumeFileSaved?.(file);
      toast.success("Resume saved");
    } catch (err: any) {
      if (reqId === activeUploadRef.current) {
        setResumeError(err?.message || "Couldn't upload your resume.");
      }
    } finally {
      if (reqId === activeUploadRef.current) {
        setResumeUploading(false);
        setPendingUploadName(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (mobileFileInputRef.current) mobileFileInputRef.current.value = "";
      }
    }
  };

  const openPicker = () => {
    if (!resumeUploading) fileInputRef.current?.click();
  };

  const openMobilePicker = () => {
    if (!resumeUploading) mobileFileInputRef.current?.click();
  };

  // View/Download link to the file uploaded in this session (an object URL; nothing is fetched from the server).
  const [resumeFileUrl, setResumeFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!resumeFile) {
      setResumeFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(resumeFile);
    setResumeFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [resumeFile]);

  const handleFinish = () => {
    if (isSaving || resumeUploading) return;
    onFinish();
  };

  const mobileCardClass =
    "bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 md:p-7 shadow-sm md:shadow-md space-y-4 md:flex md:flex-col md:justify-between md:h-full";

  const cardClass =
    "bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 md:p-7 shadow-xs space-y-4 flex flex-col justify-between";

  return (
    <>
      {/* ============================================================
          MOBILE / TABLET (<1024px): main-branch markup, unchanged.
          ============================================================ */}
      <div className="lg:hidden w-full max-w-lg md:max-w-2xl lg:max-w-4xl mx-auto flex flex-col pb-24 md:pb-12 pt-3 md:pt-8 px-4 sm:px-6 md:px-8">
        {/* Profile-style header: back control + title */}
        <div className="relative flex items-center justify-center min-h-[44px] mb-2 md:mb-6">
          <button
            type="button"
            onClick={onBack}
            disabled={isSaving || resumeUploading}
            aria-label="Back to preferences"
            data-testid="btn-step2-back-mobile"
            className="absolute left-0 w-11 h-11 -ml-2 inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF]"
          >
            <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          </button>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Profile</h2>
        </div>
        {/* Step instruction (neutral copy; the former assistant persona header was removed by owner decision) */}
        <p className="mb-6 md:mb-8 text-base md:text-lg font-semibold text-zinc-900 dark:text-zinc-100 leading-relaxed">
          {isFeatureEnabled
            ? "Optional: add your LinkedIn profile and resume. You can skip either one and add them later."
            : "Profile extras are coming soon. Skip ahead to your recommendations."}
        </p>

        {!isFeatureEnabled ? (
          <div className="space-y-4 md:space-y-0 md:grid md:grid-cols-2 md:gap-6 md:items-stretch">
            {[
              { title: "LinkedIn profile", icon: <LinkedInIcon className="w-5 h-5 text-[#0077b5]" /> },
              { title: "Upload resume", icon: <FileText className="w-5 h-5 text-[#0020B0]" /> },
            ].map((c) => (
              <div key={c.title} className={`${mobileCardClass} opacity-80 flex items-center gap-3`}>
                {c.icon}
                <span className="flex-1 text-sm font-bold text-zinc-900 dark:text-zinc-100">{c.title}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                  Coming soon
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {/* CARD 1: LinkedIn URL (validated + normalized only; never scraped) */}
            <section data-testid="card-linkedin-mobile" aria-labelledby="linkedin-card-title-mobile" className={`${mobileCardClass} text-center`}>
              <div className="w-20 h-20 mx-auto rounded-full bg-[#E6F2FF] flex items-center justify-center text-[#0020B0]">
                <LinkedInIcon className="w-10 h-10" />
              </div>
              <h3 id="linkedin-card-title-mobile" className="sr-only">
                LinkedIn profile URL
              </h3>
              <form onSubmit={handleSaveLinkedIn} className="space-y-3 text-left" noValidate>
                <div className="relative">
                  <input
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    data-testid="input-linkedin-url-mobile"
                    aria-label="LinkedIn profile URL (mobile)"
                    aria-invalid={Boolean(linkedinError)}
                    aria-describedby={linkedinError ? "linkedin-error-mobile" : undefined}
                    value={linkedinInput}
                    onChange={(e) => {
                      setLinkedinInput(e.target.value);
                      setLinkedinError(null);
                      setLinkedinSaved(false);
                    }}
                    placeholder="linkedin.com/in/your-name"
                    className="w-full min-h-[48px] pl-4 pr-10 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#0082FF]"
                  />
                  {validateAndNormalizeLinkedInUrl(linkedinInput).valid && (
                    <Check
                      data-testid="linkedin-valid-check-mobile"
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#0020B0]"
                      aria-hidden="true"
                    />
                  )}
                </div>
                {linkedinError && (
                  <p
                    id="linkedin-error-mobile"
                    role="alert"
                    data-testid="linkedin-error-mobile"
                    className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1.5"
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {linkedinError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={linkedinSaving || !linkedinInput.trim() || linkedinSaved}
                  data-testid="btn-save-linkedin-mobile"
                  className="w-full min-h-[48px] rounded-xl text-sm font-bold text-[#0F172A] bg-[#0082FF] hover:bg-[#0039F5] hover:text-white active:bg-[#0039F5] active:text-white disabled:opacity-50 inline-flex items-center justify-center gap-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF] focus-visible:ring-offset-2"
                >
                  {linkedinSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {linkedinSaving ? "Saving..." : linkedinEverSaved ? "Update your LinkedIn URL" : "Save LinkedIn URL"}
                </button>
                {linkedinSaved && (
                  <p role="status" className="text-xs text-center text-[#0020B0] dark:text-brand-300">
                    Saved
                  </p>
                )}
              </form>
              <button
                type="button"
                onClick={() => setShowLinkedinHelp((v) => !v)}
                aria-expanded={showLinkedinHelp}
                aria-controls="linkedin-help-mobile"
                data-testid="btn-linkedin-help-mobile"
                className="min-h-[44px] px-2 text-sm font-semibold text-[#0020B0] underline underline-offset-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF]"
              >
                Where do I find my profile URL?
              </button>
              {showLinkedinHelp && (
                <p id="linkedin-help-mobile" className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  Open your own profile on LinkedIn. The address that starts with linkedin.com/in/ is your profile URL.
                </p>
              )}
            </section>

            {/* CARD 2: Resume upload (stored privately; text parsed server-side for ranking) */}
            <section data-testid="card-resume-mobile" aria-labelledby="resume-card-title-mobile" className={`${mobileCardClass} text-center`}>
              <div className="relative w-20 h-20 mx-auto rounded-full bg-[#E6F2FF] flex items-center justify-center text-[#0020B0]">
                <FileText className="w-10 h-10" aria-hidden="true" />
                {resumeName && (
                  <span
                    data-testid="resume-saved-badge-mobile"
                    className="absolute bottom-1 right-1 w-6 h-6 rounded-md bg-[#0082FF] text-white flex items-center justify-center"
                  >
                    <Check className="w-4 h-4" aria-hidden="true" />
                    <span className="sr-only">Saved</span>
                  </span>
                )}
              </div>
              <div>
                <h3 id="resume-card-title-mobile" className="text-base font-bold text-zinc-900 dark:text-zinc-100 break-all">
                  {resumeName || "Upload resume"}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">PDF or DOCX, up to 5 MB. Stored privately.</p>
              </div>
              <input
                ref={mobileFileInputRef}
                type="file"
                accept={ACCEPT}
                aria-label="Upload resume file (PDF or DOCX) (mobile)"
                data-testid="input-resume-file-mobile"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadResume(f);
                }}
                className="hidden"
              />
              <div className="space-y-2">
                <button
                  type="button"
                  data-testid="resume-dropzone-mobile"
                  onClick={openMobilePicker}
                  disabled={resumeUploading}
                  aria-describedby={resumeError ? "resume-error-mobile" : undefined}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void uploadResume(f);
                  }}
                  className={`w-full min-h-[48px] rounded-xl text-sm font-bold text-[#0F172A] bg-[#0082FF] hover:bg-[#0039F5] hover:text-white active:bg-[#0039F5] active:text-white disabled:opacity-50 inline-flex items-center justify-center gap-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF] focus-visible:ring-offset-2${isDragging ? " ring-2 ring-[#0039F5]" : ""}`}
                >
                  {resumeUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Uploading and reading...
                    </>
                  ) : (
                    "Upload resume"
                  )}
                </button>
                {resumeName && resumeFileUrl && (
                  <>
                    <a data-testid="btn-resume-view-mobile" href={resumeFileUrl} target="_blank" rel="noopener noreferrer" className="w-full min-h-[48px] inline-flex items-center justify-center rounded-xl text-sm font-bold text-[#0020B0] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-[#0082FF] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF]">
                      View
                    </a>
                    <a data-testid="btn-resume-download-mobile" href={resumeFileUrl} download={resumeName} className="w-full min-h-[48px] inline-flex items-center justify-center rounded-xl text-sm font-bold text-[#0020B0] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-[#0082FF] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF]">
                      Download
                    </a>
                  </>
                )}
              </div>
              {resumeError && (
                <p
                  id="resume-error-mobile"
                  role="alert"
                  data-testid="resume-error-mobile"
                  className="text-xs text-red-700 dark:text-red-300 flex items-center justify-center gap-1.5"
                >
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {resumeError}
                </p>
              )}
              {resumeName && !resumeError && (
                <p data-testid="resume-success-mobile" className="text-xs text-[#0020B0] dark:text-brand-300 flex items-center justify-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Resume saved
                </p>
              )}
              {resumeName && !resumeError && describeResumeParse(resumeParse) && (
                <p
                  data-testid="resume-parse-status-mobile"
                  data-status={resumeParse?.status}
                  aria-live="polite"
                  className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400"
                >
                  {describeResumeParse(resumeParse)}
                </p>
              )}
            </section>
          </div>
        )}

        <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:bg-transparent md:border-0 md:p-0 md:mt-8 md:backdrop-blur-none">
          <div className="max-w-lg md:max-w-none mx-auto space-y-2.5 md:space-y-4">
            <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 md:h-2 rounded-full overflow-hidden">
              <div className="bg-[#0082FF] h-full rounded-full" style={{ width: "100%" }} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs md:text-sm font-semibold text-zinc-400 dark:text-zinc-500">Step 2 of 2</span>
              <button
                type="button"
                disabled={isSaving || resumeUploading}
                onClick={handleFinish}
                data-testid="btn-onboarding-finish-mobile"
                className="min-h-[44px] px-6 sm:px-8 md:px-10 py-2.5 md:py-3.5 rounded-full text-sm md:text-base font-bold text-[#0F172A] bg-[#0082FF] hover:bg-[#0039F5] hover:text-white active:bg-[#0039F5] active:text-white shadow-md md:hover:shadow-lg transition disabled:opacity-50"
              >
                {isSaving ? "Saving..." : linkedinSaved || resumeName ? "Finish" : "Skip for now"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================
          DESKTOP (>=1024px): split-shell redesign with processing screen.
          ============================================================ */}
      <div className="hidden lg:flex min-h-screen w-full bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        {/* 1. LEFT WELCOME PANEL (Consistent split shell with Step 1) */}
        <aside className="w-[42%] xl:w-[40%] bg-gradient-to-br from-brand-50/90 via-brand-50/70 to-brand-100/50 dark:from-zinc-950 dark:via-brand-900/20 dark:to-zinc-900 border-r border-brand-100/80 dark:border-zinc-800/80 flex flex-col justify-between p-12 sticky top-0 h-screen flex-shrink-0">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white dark:bg-zinc-800 border border-brand-500/20 shadow-xs flex items-center justify-center p-2 text-brand-600">
                <BrandIcon className="w-6 h-6" />
              </div>
              <div>
                <span className="text-base font-black tracking-tight text-zinc-900 dark:text-white">
                  CareerMonke
                </span>
                <span className="block text-[11px] font-semibold text-brand-700 dark:text-brand-400">
                  Profile & Resume
                </span>
              </div>
            </div>
          </div>

          {/* Welcome Block */}
          <div className="space-y-4 max-w-md">
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-brand-200/80 dark:border-brand-800/50 shadow-xs">
              <div className="w-2 h-2 rounded-full bg-brand-500" />
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                Personalized Matching
              </span>
            </div>

            <h1 className="text-3xl xl:text-4xl font-black text-zinc-900 dark:text-white tracking-tight leading-tight">
              Supercharge your match with your resume
            </h1>

            <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              {isFeatureEnabled
                ? "Upload your resume or LinkedIn PDF to extract verified skills and experience for highly targeted job matches. You can skip either one."
                : "Profile extras are coming soon. Continue to view your personalized recommendations."}
            </p>
          </div>

          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            Step 2 of 2 · Resume & LinkedIn Profile
          </div>
        </aside>

        {/* 2. RIGHT FORM PANEL */}
        <section className="flex-1 flex flex-col justify-between min-h-screen bg-white dark:bg-zinc-950 overflow-y-auto">
          <div>
            {/* Top Header Row with Back and Logout */}
            <div className="w-full flex items-center justify-between px-8 pt-6 pb-2">
              <button
                type="button"
                onClick={onBack}
                disabled={isSaving || resumeUploading}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition disabled:opacity-40"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to preferences</span>
              </button>

              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Logout</span>
                </button>
              )}
            </div>

            {/* Form Content / Cards */}
            <div className="max-w-xl w-full mx-auto px-8 py-6 space-y-6">
              {!isFeatureEnabled ? (
                <div className="space-y-4">
                  {[
                    { title: "LinkedIn profile", icon: <LinkedInIcon className="w-5 h-5 text-[#0077b5]" /> },
                    { title: "Upload resume", icon: <FileText className="w-5 h-5 text-brand-600" /> },
                  ].map((c) => (
                    <div key={c.title} className={`${cardClass} opacity-80 flex flex-row items-center gap-3`}>
                      {c.icon}
                      <span className="flex-1 text-sm font-bold text-zinc-900 dark:text-zinc-100">{c.title}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                        Coming soon
                      </span>
                    </div>
                  ))}
                </div>
              ) : resumeUploading ? (
                /* Mounting honest OnboardingProcessingScreen while request is pending */
                <OnboardingProcessingScreen
                  fileName={pendingUploadName}
                  statusText="Uploading and reading your resume..."
                  subText="Extracting your skills, job roles, and experience to rank your recommended matches."
                />
              ) : (
                <div className="space-y-6">
                  {/* CARD 1: Resume or LinkedIn "Save to PDF" upload */}
                  <section data-testid="card-resume" aria-labelledby="resume-card-title" className={cardClass}>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-brand-500/10 flex items-center justify-center text-brand-600 flex-shrink-0">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 id="resume-card-title" className="text-sm font-bold text-zinc-900 dark:text-zinc-100 break-words">
                          Upload resume or LinkedIn PDF
                        </h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 break-words">PDF or DOCX, up to 5 MB. Stored privately.</p>
                      </div>
                      <div className="flex-shrink-0">
                        {resumeName ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-600 dark:text-brand-400">
                            <Check className="w-3 h-3" /> Saved
                          </span>
                        ) : resumeSkipped ? (
                          <span className="text-[11px] font-semibold text-zinc-400">Skipped</span>
                        ) : (
                          <SkipLink onClick={() => setResumeSkipped(true)} label="Skip resume upload" testId="skip-resume" />
                        )}
                      </div>
                    </div>

                    {!resumeSkipped && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept={ACCEPT}
                          aria-label="Upload resume file (PDF or DOCX)"
                          data-testid="input-resume-file"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void uploadResume(f);
                          }}
                          className="hidden"
                        />
                        <button
                          type="button"
                          data-testid="resume-dropzone"
                          onClick={openPicker}
                          disabled={resumeUploading}
                          aria-describedby={resumeError ? "resume-error" : undefined}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setIsDragging(true);
                          }}
                          onDragLeave={(e) => {
                            e.preventDefault();
                            setIsDragging(false);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setIsDragging(false);
                            const f = e.dataTransfer.files?.[0];
                            if (f) void uploadResume(f);
                          }}
                          className={`w-full border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center transition flex flex-col items-center justify-center min-h-[160px] ${
                            isDragging
                              ? "border-brand-500 bg-brand-50/50 dark:bg-brand-900/30"
                              : "border-zinc-300 dark:border-zinc-700 hover:border-brand-500/80 bg-zinc-50/50 dark:bg-zinc-800/40"
                          }`}
                        >
                          {resumeName ? (
                            <span className="flex flex-col items-center gap-1.5">
                              <FileCheck className="w-7 h-7 text-brand-600" />
                              <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 break-all">{resumeName}</span>
                              <span className="text-[11px] text-brand-600 dark:text-brand-400 font-medium">Choose another file to replace</span>
                            </span>
                          ) : (
                            <span className="flex flex-col items-center gap-1.5">
                              <Upload className="w-7 h-7 text-zinc-400" />
                              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">Choose a file or drag & drop</span>
                              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">PDF or DOCX up to 5 MB</span>
                            </span>
                          )}
                        </button>

                        <p data-testid="resume-linkedin-hint" className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          No resume handy? Upload your LinkedIn profile instead: on LinkedIn, open your profile, tap{" "}
                          <span className="font-semibold text-zinc-700 dark:text-zinc-300">More</span>, then{" "}
                          <span className="font-semibold text-zinc-700 dark:text-zinc-300">Save to PDF</span>, and add that file here.
                        </p>

                        {resumeError && (
                          <p
                            id="resume-error"
                            role="alert"
                            data-testid="resume-error"
                            className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1.5"
                          >
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {resumeError}
                          </p>
                        )}

                        {resumeName && !resumeError && (
                          <p data-testid="resume-success" className="text-xs text-brand-700 dark:text-brand-300 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Resume saved
                          </p>
                        )}

                        {resumeName && !resumeError && describeResumeParse(resumeParse) && (
                          <p
                            data-testid="resume-parse-status"
                            data-status={resumeParse?.status}
                            aria-live="polite"
                            className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400"
                          >
                            {describeResumeParse(resumeParse)}
                          </p>
                        )}
                      </>
                    )}
                  </section>

                  {/* CARD 2: LinkedIn profile URL */}
                  <section data-testid="card-linkedin" aria-labelledby="linkedin-card-title" className={cardClass}>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-[#0077b5]/10 flex items-center justify-center text-[#0077b5] flex-shrink-0">
                        <LinkedInIcon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 id="linkedin-card-title" className="text-sm font-bold text-zinc-900 dark:text-zinc-100 break-words">
                          LinkedIn profile URL
                        </h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 break-words">e.g. https://www.linkedin.com/in/yourname</p>
                      </div>
                      <div className="flex-shrink-0">
                        {linkedinSaved ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-600 dark:text-brand-400">
                            <Check className="w-3 h-3" /> Saved
                          </span>
                        ) : linkedinSkipped ? (
                          <span className="text-[11px] font-semibold text-zinc-400">Skipped</span>
                        ) : (
                          <SkipLink onClick={() => setLinkedinSkipped(true)} label="Skip LinkedIn URL" testId="skip-linkedin" />
                        )}
                      </div>
                    </div>

                    {!linkedinSkipped && (
                      <form onSubmit={handleSaveLinkedIn} className="space-y-3" noValidate>
                        <div className="space-y-2">
                          <input
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            data-testid="input-linkedin-url"
                            aria-label="LinkedIn profile URL"
                            aria-invalid={Boolean(linkedinError)}
                            aria-describedby={linkedinError ? "linkedin-error" : undefined}
                            value={linkedinInput}
                            onChange={(e) => {
                              setLinkedinInput(e.target.value);
                              setLinkedinError(null);
                              setLinkedinSaved(false);
                            }}
                            placeholder="https://www.linkedin.com/in/your-profile"
                            className="w-full px-4 py-2.5 sm:py-3 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          {linkedinError && (
                            <p
                              id="linkedin-error"
                              role="alert"
                              data-testid="linkedin-error"
                              className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1.5"
                            >
                              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {linkedinError}
                            </p>
                          )}
                        </div>
                        <div className="flex justify-end pt-1">
                          <button
                            type="submit"
                            disabled={linkedinSaving || !linkedinInput.trim() || linkedinSaved}
                            data-testid="btn-save-linkedin"
                            className="px-5 sm:px-6 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-bold text-white bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50 inline-flex items-center gap-1.5 shadow-xs"
                          >
                            {linkedinSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {linkedinSaved ? "Saved" : linkedinSaving ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </form>
                    )}
                  </section>
                </div>
              )}
            </div>
          </div>

          {/* 3. Bottom Navigation Bar */}
          <div className="w-full bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-100 dark:border-zinc-800 p-6 mt-6">
            <div className="max-w-xl mx-auto space-y-3">
              <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-2 rounded-full overflow-hidden">
                <div className="bg-brand-500 h-full rounded-full" style={{ width: "100%" }} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-zinc-400 dark:text-zinc-500">Step 2 of 2</span>
                <button
                  type="button"
                  disabled={isSaving || resumeUploading}
                  onClick={handleFinish}
                  data-testid="btn-onboarding-finish"
                  className="px-10 py-3.5 rounded-full text-base font-bold text-white bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 shadow-md hover:shadow-lg transition disabled:opacity-50"
                >
                  {isSaving
                    ? "Saving..."
                    : linkedinSaved || resumeName
                      ? "Continue to Jobs"
                      : "Skip for now & Continue to Jobs"}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
