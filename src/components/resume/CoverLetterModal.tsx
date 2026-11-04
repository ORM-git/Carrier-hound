"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Copy, Download, Check, Sparkles, FileText, ArrowRight, ShieldCheck, AlertCircle, Info } from "lucide-react";
import { CandidateProfile } from "@/lib/resume/types";
import {
  generateTailoredCoverLetter,
  validateCoverLetter,
  formatContactHeader,
  computeCandidateFactsHash,
  computeJobHash,
} from "@/lib/resume/tailor";
import {
  getCachedTailoredCoverLetter,
  saveCachedTailoredCoverLetter,
  getTailoredCoverLetterAsync,
  purgeTailoredCoverLetter,
  COVER_LETTER_CACHE_VERSION,
} from "@/lib/resume/storage";
import { downloadCoverLetterPdf } from "@/lib/resume/atsPdfGenerator";
import {
  generateGroqTailoredCoverLetter,
  getGroqApiKey,
  GENERIC_AI_UNAVAILABLE_MESSAGE,
  sanitizeUserFacingAiError,
} from "@/lib/ai/groq";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { buildCoverLetterDocHtml, sanitizeDownloadFilename } from "@/lib/security/xss";
import { toast } from "react-toastify";
import { createClient } from "@/lib/supabase/client";

interface CoverLetterModalProps {
  userId?: string | null;
  isPro?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: CandidateProfile;
  job: {
    id?: string;
    title: string;
    company: string;
    description?: string;
    location?: string;
  };
}

export default function CoverLetterModal({
  open,
  onOpenChange,
  candidate,
  job,
  userId,
  isPro,
}: CoverLetterModalProps) {
  const [isProUser, setIsProUser] = useState<boolean | null>(
    typeof isPro === "boolean" ? isPro : null
  );

  useEffect(() => {
    if (typeof isPro === "boolean") {
      setIsProUser(isPro);
    } else {
      getProAccessStatus().then((res) => setIsProUser(res.isPro)).catch(() => setIsProUser(null));
    }
  }, [isPro]);

  const [content, setContent] = useState("");
  const [copied, setCopied] = useState(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isValidated, setIsValidated] = useState(true);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const jobId = job.id || `${(job.company || "").replace(/\s+/g, "-")}_${(job.title || "").replace(/\s+/g, "-")}`;

  const [activeOwnerId, setActiveOwnerId] = useState<string | null>(
    userId === "guest" ? "guest" : null
  );
  const activeOwnerIdRef = useRef<string | null>(
    userId === "guest" ? "guest" : null
  );
  const authGenerationRef = useRef<number>(0);

  const getVerifiedSessionUserId = async (): Promise<string | null> => {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      return session?.user?.id ?? null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    let isMounted = true;
    const syncOwner = async () => {
      authGenerationRef.current++;
      const sessionUserId = await getVerifiedSessionUserId();
      // Verified session user strictly determines owner.
      // A null/failed session must NEVER resurrect an old prop identity.
      const resolved = sessionUserId ?? (userId === "guest" ? "guest" : null);
      if (isMounted) {
        setActiveOwnerId(resolved);
        activeOwnerIdRef.current = resolved;
      }
    };
    syncOwner();
    const handleAuth = () => syncOwner();
    window.addEventListener("careermonke_auth_updated", handleAuth);

    let authListener: { unsubscribe: () => void } | null = null;
    try {
      const supabase = createClient();
      const { data } = supabase.auth.onAuthStateChange(() => {
        syncOwner();
      });
      authListener = data.subscription;
    } catch {}

    return () => {
      isMounted = false;
      window.removeEventListener("careermonke_auth_updated", handleAuth);
      authListener?.unsubscribe();
    };
  }, [userId]);

  useEffect(() => {
    if (open && candidate && job) {
      setAiNotice(null);
      const currentOwner = activeOwnerId;
      const candidateHash = computeCandidateFactsHash(candidate);
      const jHash = computeJobHash(job);
      const validationContext = {
        candidateFactsHash: candidateHash,
        jobHash: jHash,
        candidate,
        job,
      };

      // For authenticated work, stop safely when no owner is verified: clean rules-based, no cache
      if (!currentOwner) {
        const result = generateTailoredCoverLetter(candidate, job);
        setContent(result.fullText);
        setIsValidated(true);
        return;
      }

      // 1. Check per-job cache first
      const cached = getCachedTailoredCoverLetter(jobId, currentOwner, validationContext);
      if (cached && cached.fullText) {
        const validation = validateCoverLetter(cached.fullText, candidate, job);
        if (validation.valid) {
          setContent(cached.fullText);
          setIsValidated(true);
          return;
        } else {
          // Stale / unverified cached entry: purge and generate fresh validated draft
          purgeTailoredCoverLetter(jobId, currentOwner);
        }
      }

      // Check remote Supabase cache before fresh generation
      getTailoredCoverLetterAsync(jobId, currentOwner, validationContext)
        .then((remote) => {
          if (activeOwnerIdRef.current !== currentOwner) return;
          if (remote && remote.fullText) {
            const validation = validateCoverLetter(remote.fullText, candidate, job);
            if (validation.valid) {
              setContent(remote.fullText);
              setIsValidated(true);
              return;
            } else {
              purgeTailoredCoverLetter(jobId, currentOwner);
            }
          }

          // 2. Generate deterministic tailored cover letter from job context
          const result = generateTailoredCoverLetter(candidate, job);
          setContent(result.fullText);
          setIsValidated(true);
          saveCachedTailoredCoverLetter(jobId, result, currentOwner);

          // 3. If Groq API Key is configured and user is Pro, enhance with SMART_MODEL under hard evidence validation
          if (isProUser && getGroqApiKey()) {
            setIsGeneratingAi(true);
            const currentGen = ++authGenerationRef.current;
            generateGroqTailoredCoverLetter(candidate, job)
              .then(async (res) => {
                const liveSessionUserId = await getVerifiedSessionUserId();
                const liveExpectedOwner = liveSessionUserId ?? (userId === "guest" ? "guest" : null);
                if (
                  authGenerationRef.current !== currentGen ||
                  currentOwner !== liveExpectedOwner ||
                  currentOwner !== activeOwnerIdRef.current
                ) {
                  console.warn("Auth changed during cover letter generation; discarding result.");
                  return;
                }
                if (res.isAiEnhanced) {
                  setAiNotice(null);
                  if (res.text) {
                    setContent(res.text);
                    setIsValidated(res.isValidated);
                    saveCachedTailoredCoverLetter(
                      jobId,
                      {
                        ...result,
                        fullText: res.text,
                        paragraphs: res.text.split("\n\n").filter(Boolean),
                        isValidated: res.isValidated,
                        cacheVersion: COVER_LETTER_CACHE_VERSION,
                        generatorId: "groq-cover_letter-v2",
                        candidateFactsHash: candidateHash,
                        jobHash: jHash,
                      },
                      currentOwner
                    );
                  }
                } else {
                  // AI Enhance failed or reverted to factual draft: show neutral notice
                  const noticeMsg = sanitizeUserFacingAiError(res.error) || GENERIC_AI_UNAVAILABLE_MESSAGE;
                  setAiNotice(noticeMsg);
                  setIsValidated(true);
                  if (res.error && !res.error.includes("GROQ_API_KEY")) {
                    toast.warn(sanitizeUserFacingAiError(res.error));
                  }
                }
              })
              .catch(() => {
                setAiNotice(GENERIC_AI_UNAVAILABLE_MESSAGE);
                setIsValidated(true);
              })
              .finally(() => {
                setIsGeneratingAi(false);
              });
          }
        })
        .catch(() => {
          const result = generateTailoredCoverLetter(candidate, job);
          setContent(result.fullText);
          setIsValidated(true);
          if (currentOwner) {
            saveCachedTailoredCoverLetter(jobId, result, currentOwner);
          }
        });
    }
  }, [open, candidate, job, jobId, activeOwnerId]);

  if (!open) return null;

  const verifyExportAllowed = async (): Promise<boolean> => {
    if (userId === "guest") return true;
    const liveSessionUser = await getVerifiedSessionUserId();
    if (!liveSessionUser || liveSessionUser !== activeOwnerIdRef.current) {
      toast.error("Please sign in with your active account to export tailored documents.");
      return false;
    }
    return true;
  };

  const validateBeforeExport = (): boolean => {
    const validation = validateCoverLetter(content, candidate, job);
    if (!validation.valid) {
      setIsValidated(false);
      const reason = validation.reasons[0] || "Unverified claims detected.";
      toast.error(`Cannot export cover letter with unverified claims: ${reason}`);
      if (activeOwnerId) {
        saveCachedTailoredCoverLetter(
          jobId,
          {
            recipient: `Hiring Team at ${job.company}`,
            company: job.company,
            jobTitle: job.title,
            salutation: `Dear Hiring Team at ${job.company},`,
            contactHeader: formatContactHeader(candidate),
            paragraphs: content.split("\n\n").filter(Boolean),
            fullText: content,
            isValidated: false,
            cacheVersion: COVER_LETTER_CACHE_VERSION,
            generatorId: "user-edited-v2",
            candidateFactsHash: computeCandidateFactsHash(candidate),
            jobHash: computeJobHash(job),
          },
          activeOwnerId
        );
      }
      return false;
    }
    return true;
  };

  const handleDownloadPdf = async () => {
    if (!validateBeforeExport()) return;
    if (!(await verifyExportAllowed())) return;
    downloadCoverLetterPdf({
      candidate,
      company: job.company,
      jobTitle: job.title,
      content,
    });
    toast.success("Cover letter downloaded as clean PDF!");
  };

  const handleContentChange = (newVal: string) => {
    setContent(newVal);
    const validation = validateCoverLetter(newVal, candidate, job);
    setIsValidated(validation.valid);
    if (activeOwnerId) {
      saveCachedTailoredCoverLetter(
        jobId,
        {
          recipient: `Hiring Team at ${job.company}`,
          company: job.company,
          jobTitle: job.title,
          salutation: `Dear Hiring Team at ${job.company},`,
          contactHeader: formatContactHeader(candidate),
          paragraphs: newVal.split("\n\n").filter(Boolean),
          fullText: newVal,
          isValidated: validation.valid,
          cacheVersion: COVER_LETTER_CACHE_VERSION,
          generatorId: "user-edited-v2",
          candidateFactsHash: computeCandidateFactsHash(candidate),
          jobHash: computeJobHash(job),
        },
        activeOwnerId
      );
    }
  };

  const handleCopy = async () => {
    if (!validateBeforeExport()) return;
    if (!(await verifyExportAllowed())) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success("Cover letter copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTxt = async () => {
    if (!validateBeforeExport()) return;
    if (!(await verifyExportAllowed())) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeComp = sanitizeDownloadFilename(job.company, "Company");
    const safeRole = sanitizeDownloadFilename(job.title, "Role");
    a.download = `Cover_Letter_${safeComp}_${safeRole}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Cover letter downloaded as text file!");
  };

  const handleDownloadDoc = async () => {
    if (!validateBeforeExport()) return;
    if (!(await verifyExportAllowed())) return;
    // Generate clean Word-compatible document with strict HTML escaping
    const html = buildCoverLetterDocHtml(job.company, content);
    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeComp = sanitizeDownloadFilename(job.company, "Company");
    const safeRole = sanitizeDownloadFilename(job.title, "Role");
    a.download = `Cover_Letter_${safeComp}_${safeRole}.doc`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Cover letter downloaded as Word document!");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
      <div
        className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh] animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-gradient-to-r from-blue-900 via-blue-800 to-indigo-900 text-white flex items-start justify-between relative">
          <div className="pr-8 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/20 text-white backdrop-blur-xs">
                <Sparkles className={`w-3 h-3 ${isGeneratingAi ? "animate-spin text-cyan-300" : "text-yellow-300"}`} />
                {isGeneratingAi ? "Validating evidence..." : "1-Click Tailored Cover Letter"}
              </span>
              {isValidated ? (
                <span className="text-xs text-blue-200 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
                  Grounded in verified facts
                </span>
              ) : (
                <span className="text-xs text-amber-200 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Contains unverified claims
                </span>
              )}
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white line-clamp-1">
              Application for {job.title}
            </h2>
            <p className="text-xs sm:text-sm text-blue-100">
              Prepared for {job.company} • Matches confirmed skills
            </p>
          </div>

          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer min-h-[44px] min-w-[44px]"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {aiNotice && (
            <div
              data-testid="cover-letter-ai-notice"
              className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 text-xs"
            >
              <Info className="w-4 h-4 text-slate-500 shrink-0" />
              <span>{aiNotice}</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-slate-500 pb-1">
            <span>You can review and edit this letter directly before submitting:</span>
            <span className="font-mono text-slate-400">{content.length} characters</span>
          </div>

          <textarea
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            rows={14}
            className="w-full p-4 rounded-xl border border-slate-200 font-sans text-xs sm:text-sm text-slate-800 leading-relaxed focus:ring-2 focus:ring-blue-500 focus:outline-hidden resize-none bg-slate-50/50"
            placeholder="Generated cover letter will appear here..."
          />
        </div>

        {/* Action Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="px-4 py-2.5 rounded-xl text-xs font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer min-h-[44px]"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download PDF (.pdf)</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadDoc}
              className="px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer min-h-[44px]"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>Word (.doc)</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadTxt}
              className="px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer min-h-[44px]"
            >
              <FileText className="w-3.5 h-3.5 text-slate-500" />
              <span>Text (.txt)</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white shadow-xs flex items-center gap-1.5 transition-all cursor-pointer min-h-[44px]"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-emerald-300" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
