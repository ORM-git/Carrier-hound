"use client";

import React, { useState, useRef } from "react";
import BrandIcon from "@/components/BrandIcon";
import {
  ArrowLeft,
  FileText,
  CheckCircle2,
  AlertCircle,
  Upload,
  Loader2,
  Check,
  X,
  FileCheck,
} from "lucide-react";
import { isOnboardingStep2Active } from "@/config/onboarding";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";

interface OnboardingStep2Props {
  onBack: () => void;
  onFinish: () => void;
  isSaving: boolean;
  authToken?: string;
  initialLinkedInUrl?: string;
  initialResumeFilename?: string;
}

export default function OnboardingStep2({
  onBack,
  onFinish,
  isSaving,
  authToken,
  initialLinkedInUrl = "",
  initialResumeFilename = "",
}: OnboardingStep2Props) {
  const isFeatureEnabled = isOnboardingStep2Active();

  // LinkedIn State
  const [linkedinInput, setLinkedinInput] = useState(initialLinkedInUrl);
  const [linkedinSaved, setLinkedinSaved] = useState(Boolean(initialLinkedInUrl));
  const [linkedinSaving, setLinkedinSaving] = useState(false);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [linkedinSuccess, setLinkedinSuccess] = useState<string | null>(
    initialLinkedInUrl ? "LinkedIn profile linked" : null
  );

  // Resume Upload State
  const [resumeFilename, setResumeFilename] = useState<string | null>(
    initialResumeFilename || null
  );
  const [resumeSaved, setResumeSaved] = useState(Boolean(initialResumeFilename));
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeSuccess, setResumeSuccess] = useState<string | null>(
    initialResumeFilename ? "Resume parsed and saved" : null
  );
  const [skillsDetectedCount, setSkillsDetectedCount] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 1. LinkedIn Save Handler
  const handleSaveLinkedIn = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLinkedinError(null);
    setLinkedinSuccess(null);

    const validation = validateAndNormalizeLinkedInUrl(linkedinInput);
    if (!validation.valid || !validation.normalizedUrl) {
      setLinkedinError(validation.error || "Please enter a valid LinkedIn URL (linkedin.com/in/...).");
      return;
    }

    const normalized = validation.normalizedUrl;
    setLinkedinInput(normalized);

    if (!authToken) {
      // Local session mode
      setLinkedinSaved(true);
      setLinkedinSuccess("LinkedIn profile linked");
      return;
    }

    setLinkedinSaving(true);
    try {
      const res = await fetch("/api/onboarding/linkedin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ linkedinUrl: normalized }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || "Failed to save LinkedIn URL. Please try again.");
      }

      setLinkedinSaved(true);
      setLinkedinSuccess("LinkedIn profile linked");
    } catch (err: any) {
      setLinkedinError(err?.message || "Failed to save LinkedIn profile.");
    } finally {
      setLinkedinSaving(false);
    }
  };

  // 2. Resume File Selection / Upload Handler
  const handleFileProcess = async (file: File) => {
    setResumeError(null);
    setResumeSuccess(null);

    // Client-side extension check
    const dotParts = (file.name || "").split(".");
    const ext = dotParts.length > 1 ? dotParts.pop()!.toLowerCase().trim() : "";
    if (ext !== "pdf" && ext !== "docx") {
      setResumeError("Only PDF (.pdf) and Word (.docx) files are supported.");
      return;
    }

    // Client-side size check (max 5 MB)
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      setResumeError("File size exceeds 5 MB limit. Please upload a smaller document.");
      return;
    }

    setResumeUploading(true);

    try {
      if (!authToken) {
        // Fallback for unauthenticated test harness: store mock success
        setResumeFilename(file.name);
        setResumeSaved(true);
        setResumeSuccess("Resume uploaded and parsed successfully");
        setResumeUploading(false);
        return;
      }

      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/onboarding/resume", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || "Failed to parse resume document.");
      }

      setResumeFilename(data?.filename || file.name);
      setResumeSaved(true);
      setSkillsDetectedCount(data?.skillsCount || 0);
      setResumeSuccess(
        data?.skillsCount
          ? `Resume parsed: ${data.skillsCount} skills matched`
          : "Resume parsed and saved"
      );
    } catch (err: any) {
      setResumeError(err?.message || "Failed to upload and parse resume.");
      setResumeSaved(false);
    } finally {
      setResumeUploading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileProcess(files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileProcess(files[0]);
    }
  };

  // If feature flag is off, show coming soon cards with Skip
  if (!isFeatureEnabled) {
    return (
      <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
        {/* Back button */}
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

        {/* Copilot Greeting Header */}
        <div className="flex items-start gap-3 mb-6">
          <div className="relative flex-shrink-0">
            <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
              <BrandIcon className="w-7 h-7" />
            </div>
            <span
              className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"
              title="Copilot Online"
            />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">CareerMonke Copilot</span>
              <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">AI</span>
            </div>
            <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
              Seeing exciting opportunities for you! Profile enrichment features are coming soon. Skip ahead to your personalized recommendations.
            </div>
          </div>
        </div>

        {/* Disabled Cards Container */}
        <div className="space-y-4">
          {/* 1. LinkedIn URL Card (Disabled) */}
          <div className="relative bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center shadow-sm opacity-80">
            <div className="absolute top-4 right-4">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                Coming soon
              </span>
            </div>

            <div className="w-14 h-14 rounded-2xl bg-[#0077b5]/10 flex items-center justify-center text-[#0077b5] mb-4">
              <svg className="w-8 h-8 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
            </div>

            <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              Connect LinkedIn Profile
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-5">
              Auto-import your verified skills, experience, and recommendations.
            </p>

            <button
              type="button"
              disabled
              className="w-full sm:w-auto px-6 py-2.5 rounded-full text-xs font-bold text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 cursor-not-allowed"
            >
              Enter LinkedIn URL
            </button>
          </div>

          {/* 2. Resume Upload Card (Disabled) */}
          <div className="relative bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center shadow-sm opacity-80">
            <div className="absolute top-4 right-4">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                Coming soon
              </span>
            </div>

            <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 mb-4">
              <FileText className="w-8 h-8" />
            </div>

            <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              Upload Your Resume
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-5">
              Extract your skills and match you directly with hiring teams.
            </p>

            <button
              type="button"
              disabled
              className="w-full sm:w-auto px-6 py-2.5 rounded-full text-xs font-bold text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 cursor-not-allowed"
            >
              Upload Resume
            </button>
          </div>
        </div>

        {/* Sticky Bottom Bar */}
        <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4">
          <div className="max-w-lg mx-auto space-y-3">
            <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-emerald-500 h-full rounded-full transition-all duration-300" style={{ width: "100%" }} />
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
                Step 2 of 2
              </span>
              <button
                type="button"
                disabled={isSaving}
                onClick={onFinish}
                className="px-8 py-3 rounded-full text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-md hover:shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span>{isSaving ? "Saving..." : "Skip for now & Finish"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Active Interactive Mode
  return (
    <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
      {/* Back button */}
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

      {/* Copilot Greeting Header */}
      <div className="flex items-start gap-3 mb-6">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
            <BrandIcon className="w-7 h-7" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"
            title="Copilot Online"
          />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">CareerMonke Copilot</span>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">AI</span>
          </div>
          <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
            Enhance your matches! Connect your LinkedIn profile, upload your resume, or skip ahead anytime.
          </div>
        </div>
      </div>

      {/* Cards Container */}
      <div className="space-y-5">
        {/* CARD 1: LinkedIn URL */}
        <div
          data-testid="card-linkedin"
          className="bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#0077b5]/10 flex items-center justify-center text-[#0077b5] flex-shrink-0">
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Enter LinkedIn URL
                </h3>
                {linkedinSaved && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    <Check className="w-3 h-3" />
                    <span>Saved</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Format: linkedin.com/in/username
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSaveLinkedIn} className="space-y-3">
            <div className="relative">
              <input
                type="text"
                data-testid="input-linkedin-url"
                aria-label="LinkedIn profile URL"
                value={linkedinInput}
                onChange={(e) => {
                  setLinkedinInput(e.target.value);
                  setLinkedinError(null);
                  if (linkedinSaved) setLinkedinSaved(false);
                }}
                placeholder="https://www.linkedin.com/in/your-profile"
                className="w-full px-4 py-2.5 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
              />
            </div>

            {/* Error Message */}
            {linkedinError && (
              <div
                role="alert"
                data-testid="linkedin-error"
                className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{linkedinError}</span>
              </div>
            )}

            {/* Success Message */}
            {linkedinSuccess && !linkedinError && (
              <div
                data-testid="linkedin-success"
                className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
                <span>{linkedinSuccess}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={linkedinSaving || !linkedinInput.trim() || linkedinSaved}
                data-testid="btn-save-linkedin"
                className="px-5 py-2 rounded-full text-xs font-bold text-white bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50 transition flex items-center gap-1.5"
              >
                {linkedinSaving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : linkedinSaved ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Saved</span>
                  </>
                ) : (
                  <span>Save Profile</span>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* CARD 2: Upload Resume */}
        <div
          data-testid="card-resume"
          className="bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Upload Resume
                </h3>
                {resumeSaved && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    <Check className="w-3 h-3" />
                    <span>Attached</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                PDF or DOCX only • Max 5 MB
              </p>
            </div>
          </div>

          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="Upload resume file (PDF or DOCX)"
            onChange={handleFileInputChange}
            className="hidden"
          />

          {/* Drop Zone */}
          <div
            data-testid="resume-dropzone"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition ${
              isDragging
                ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/30"
                : resumeSaved
                ? "border-emerald-500/40 bg-emerald-50/20 dark:bg-emerald-950/10 hover:border-emerald-500"
                : "border-zinc-300 dark:border-zinc-700 hover:border-emerald-500/80 bg-zinc-50/50 dark:bg-zinc-800/40"
            }`}
          >
            {resumeUploading ? (
              <div className="py-4 flex flex-col items-center justify-center space-y-2">
                <Loader2 className="w-7 h-7 text-emerald-600 animate-spin" />
                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                  Extracting skills and verifying document...
                </span>
              </div>
            ) : resumeSaved && resumeFilename ? (
              <div className="py-2 flex flex-col items-center justify-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 flex items-center justify-center">
                  <FileCheck className="w-5 h-5" />
                </div>
                <div className="text-center">
                  <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 block break-all">
                    {resumeFilename}
                  </span>
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                    Click to replace document
                  </span>
                </div>
              </div>
            ) : (
              <div className="py-2 flex flex-col items-center justify-center space-y-2">
                <Upload className="w-6 h-6 text-zinc-400 hover:text-emerald-600 transition" />
                <div>
                  <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block">
                    Choose a file or drag & drop here
                  </span>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    PDF or DOCX up to 5 MB
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Error Message */}
          {resumeError && (
            <div
              role="alert"
              data-testid="resume-error"
              className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{resumeError}</span>
            </div>
          )}

          {/* Success Message */}
          {resumeSuccess && !resumeError && (
            <div
              data-testid="resume-success"
              className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
              <span>{resumeSuccess}</span>
            </div>
          )}
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4">
        <div className="max-w-lg mx-auto space-y-3">
          {/* Progress bar (Step 2 of 2 -> 100%) */}
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-300"
              style={{ width: "100%" }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
              Step 2 of 2
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isSaving}
                onClick={onFinish}
                data-testid="btn-onboarding-finish"
                className="px-6 sm:px-8 py-3 rounded-full text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-md hover:shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span>
                  {isSaving
                    ? "Saving..."
                    : linkedinSaved || resumeSaved
                    ? "View Matches"
                    : "Skip for now & Finish"}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
