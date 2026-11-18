"use client";

import React, { useRef, useState } from "react";
import BrandIcon from "@/components/BrandIcon";
import { ArrowLeft, FileText, CheckCircle2, AlertCircle, Upload, Loader2, Check, FileCheck } from "lucide-react";
import { toast } from "react-toastify";
import { isOnboardingStep2EnabledClient } from "@/config/onboarding";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";
import { MAX_RESUME_SIZE_BYTES, RESUME_MIME } from "@/lib/onboarding/step2Resume";

interface OnboardingStep2Props {
  onBack: () => void;
  onFinish: () => void;
  isSaving: boolean;
  authToken?: string;
}

const ACCEPT = `.pdf,.docx,${RESUME_MIME.pdf},${RESUME_MIME.docx}`;

/** `parse` from POST /api/onboarding/resume (summary of the user's own parsed profile). */
export interface ResumeParseSummary {
  status: "parsed" | "failed" | "unavailable";
  reason?: "no_text" | "scanned_pdf" | "parse_error" | null;
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

export default function OnboardingStep2({ onBack, onFinish, isSaving, authToken }: OnboardingStep2Props) {
  const isFeatureEnabled = isOnboardingStep2EnabledClient();

  const [linkedinInput, setLinkedinInput] = useState("");
  const [linkedinSaved, setLinkedinSaved] = useState(false);
  const [linkedinSkipped, setLinkedinSkipped] = useState(false);
  const [linkedinSaving, setLinkedinSaving] = useState(false);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);

  const [resumeName, setResumeName] = useState<string | null>(null);
  const [resumeParse, setResumeParse] = useState<ResumeParseSummary | null>(null);
  const [resumeSkipped, setResumeSkipped] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setLinkedinInput(data.linkedinUrl || check.normalizedUrl);
      setLinkedinSaved(true);
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
    setResumeUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/onboarding/resume", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Couldn't upload your resume.");
      setResumeName(data.fileName || file.name);
      setResumeParse(data?.parse && typeof data.parse === "object" ? (data.parse as ResumeParseSummary) : null);
      toast.success("Resume saved");
    } catch (err: any) {
      setResumeError(err?.message || "Couldn't upload your resume.");
    } finally {
      setResumeUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const openPicker = () => {
    if (!resumeUploading) fileInputRef.current?.click();
  };

  const header = (
    <>
      <div className="mb-4">
        <button
          type="button"
          onClick={onBack}
          disabled={isSaving}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to preferences</span>
        </button>
      </div>
      <div className="flex items-start gap-3 mb-6">
        <div className="w-11 h-11 flex-shrink-0 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
          <BrandIcon className="w-7 h-7" />
        </div>
        <div className="flex-1">
          <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">CareerMonke Copilot</span>
          <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
            {isFeatureEnabled
              ? "Optional: add your LinkedIn profile and resume. You can skip either one and add them later."
              : "Profile extras are coming soon. Skip ahead to your recommendations."}
          </div>
        </div>
      </div>
    </>
  );

  const footer = (
    <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4">
      <div className="max-w-lg mx-auto space-y-3">
        <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
          <div className="bg-emerald-500 h-full rounded-full" style={{ width: "100%" }} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">Step 2 of 2</span>
          <button
            type="button"
            disabled={isSaving}
            onClick={onFinish}
            data-testid="btn-onboarding-finish"
            className="px-6 sm:px-8 py-3 rounded-full text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-md transition disabled:opacity-50"
          >
            {isSaving ? "Saving..." : linkedinSaved || resumeName ? "Finish" : "Skip for now & Finish"}
          </button>
        </div>
      </div>
    </div>
  );

  const cardClass =
    "bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4";

  if (!isFeatureEnabled) {
    return (
      <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
        {header}
        <div className="space-y-4">
          {[
            { title: "LinkedIn profile", icon: <LinkedInIcon className="w-5 h-5 text-[#0077b5]" /> },
            { title: "Upload resume", icon: <FileText className="w-5 h-5 text-emerald-600" /> },
          ].map((c) => (
            <div key={c.title} className={`${cardClass} opacity-80 flex items-center gap-3`}>
              {c.icon}
              <span className="flex-1 text-sm font-bold text-zinc-900 dark:text-zinc-100">{c.title}</span>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                Coming soon
              </span>
            </div>
          ))}
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
      {header}

      <div className="space-y-5">
        {/* CARD 1: LinkedIn URL (validated + normalized only; never scraped) */}
        <section data-testid="card-linkedin" aria-labelledby="linkedin-card-title" className={cardClass}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#0077b5]/10 flex items-center justify-center text-[#0077b5] flex-shrink-0">
              <LinkedInIcon className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <h3 id="linkedin-card-title" className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                LinkedIn profile URL
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">e.g. https://www.linkedin.com/in/yourname</p>
            </div>
            {linkedinSaved ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                <Check className="w-3 h-3" /> Saved
              </span>
            ) : linkedinSkipped ? (
              <span className="text-[11px] font-semibold text-zinc-400">Skipped</span>
            ) : (
              <SkipLink onClick={() => setLinkedinSkipped(true)} label="Skip LinkedIn URL" testId="skip-linkedin" />
            )}
          </div>

          {!linkedinSkipped && (
            <form onSubmit={handleSaveLinkedIn} className="space-y-3" noValidate>
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
                className="w-full px-4 py-2.5 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={linkedinSaving || !linkedinInput.trim() || linkedinSaved}
                  data-testid="btn-save-linkedin"
                  className="px-5 py-2 rounded-full text-xs font-bold text-white bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {linkedinSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {linkedinSaved ? "Saved" : linkedinSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* CARD 2: Resume or LinkedIn "Save to PDF" upload (stored privately; text parsed server-side for ranking) */}
        <section data-testid="card-resume" aria-labelledby="resume-card-title" className={cardClass}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <h3 id="resume-card-title" className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                Upload resume or LinkedIn PDF
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">PDF or DOCX, up to 5 MB. Stored privately.</p>
            </div>
            {resumeName ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                <Check className="w-3 h-3" /> Saved
              </span>
            ) : resumeSkipped ? (
              <span className="text-[11px] font-semibold text-zinc-400">Skipped</span>
            ) : (
              <SkipLink onClick={() => setResumeSkipped(true)} label="Skip resume upload" testId="skip-resume" />
            )}
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
                className={`w-full border-2 border-dashed rounded-2xl p-6 text-center transition ${
                  isDragging
                    ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/30"
                    : "border-zinc-300 dark:border-zinc-700 hover:border-emerald-500/80 bg-zinc-50/50 dark:bg-zinc-800/40"
                }`}
              >
                {resumeUploading ? (
                  <span className="flex flex-col items-center gap-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                    <Loader2 className="w-6 h-6 text-emerald-600 animate-spin" /> Uploading and reading...
                  </span>
                ) : resumeName ? (
                  <span className="flex flex-col items-center gap-1">
                    <FileCheck className="w-6 h-6 text-emerald-600" />
                    <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 break-all">{resumeName}</span>
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Choose another file to replace</span>
                  </span>
                ) : (
                  <span className="flex flex-col items-center gap-1">
                    <Upload className="w-6 h-6 text-zinc-400" />
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
                <p data-testid="resume-success" className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
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
      </div>

      {footer}
    </div>
  );
}
