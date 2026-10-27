"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  X,
  Copy,
  Download,
  Check,
  Sparkles,
  FileText,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Briefcase,
  GraduationCap,
  Eye,
  FileCode,
  RotateCw,
} from "lucide-react";
import { CandidateProfile } from "@/lib/resume/types";
import {
  tailorProfileForJobWithAts,
  TailoredJobResumeResult,
  computeResumeSourceHash,
  applyAcceptedAiDraft,
  computeJobAtsScore,
} from "@/lib/resume/atsScorer";
import { generateAiTailoredResume } from "@/lib/ai/groq";
import { getProAccessStatus } from "@/lib/billing/subscription";
import LockedPreview from "@/components/billing/LockedPreview";
import {
  getCachedTailoredResume,
  saveCachedTailoredResume,
  getTailoredResumeAsync,
} from "@/lib/resume/storage";
import { createClient } from "@/lib/supabase/client";
import { downloadAtsResumePdf } from "@/lib/resume/atsPdfGenerator";
import {
  downloadAtsResumeDocx,
  downloadAtsResumeText,
  buildAtsResumePlainText,
} from "@/lib/resume/tailor";
import { toast } from "react-toastify";

interface TailorResumeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: CandidateProfile;
  job: {
    id?: string;
    title: string;
    company: string;
    location?: string;
    category?: string;
    skills?: string[];
    description?: string;
  };
  onOpenCoverLetter?: () => void;
  userId?: string | null;
  isPro?: boolean;
}

type AiTailoringStatus = "rules" | "generating" | "reviewing" | "accepted" | "failed";

export default function TailorResumeModal({
  open,
  onOpenChange,
  candidate,
  job,
  onOpenCoverLetter,
  userId,
  isPro,
}: TailorResumeModalProps) {
  const [isProUser, setIsProUser] = useState<boolean>(Boolean(isPro));

  useEffect(() => {
    if (typeof isPro === "boolean") {
      setIsProUser(isPro);
    } else {
      getProAccessStatus().then((res) => setIsProUser(res.isPro)).catch(() => setIsProUser(false));
    }
  }, [isPro]);
  const [copied, setCopied] = useState(false);
  const [showFullPreview, setShowFullPreview] = useState(false);

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
        setPendingAiDraft(null);
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

  const [tailoredResult, setTailoredResult] = useState<TailoredJobResumeResult>(() => {
    if (userId === "guest") {
      const cached = getCachedTailoredResume(jobId, undefined, "guest");
      if (cached) return cached;
    }
    return tailorProfileForJobWithAts(candidate, job);
  });

  const [aiStatus, setAiStatus] = useState<AiTailoringStatus>(() => {
    if (userId === "guest") {
      const cached = getCachedTailoredResume(jobId, undefined, "guest");
      return cached?.tailoringSource === "ai" ? "accepted" : "rules";
    }
    return "rules";
  });
  const [aiError, setAiError] = useState<string | null>(null);
  const [pendingAiDraft, setPendingAiDraft] = useState<{
    tailoredSummary: string;
    highlightedSkills: string[];
    tailoredBullets: Record<string, string[]>;
    modelIdentity?: string;
    jobDescriptionShortened?: boolean;
    capturedOwnerId?: string | null;
    capturedGen?: number;
  } | null>(null);

  useEffect(() => {
    if (open && candidate && job) {
      const currentOwner = activeOwnerId;
      // For authenticated work, stop safely when no owner is verified: reset to rules-based
      if (!currentOwner) {
        setTailoredResult(tailorProfileForJobWithAts(candidate, job));
        setAiStatus("rules");
        return;
      }

      const expectedHash = computeResumeSourceHash(candidate, job, "1.0");
      const cached = getCachedTailoredResume(jobId, expectedHash, currentOwner);
      if (cached && cached.jobId === jobId) {
        setTailoredResult(cached);
        setAiStatus(cached.tailoringSource === "ai" ? "accepted" : "rules");
      } else {
        getTailoredResumeAsync(jobId, expectedHash, currentOwner)
          .then((remote) => {
            if (activeOwnerIdRef.current !== currentOwner) return;
            if (remote && remote.jobId === jobId) {
              setTailoredResult(remote);
              setAiStatus(remote.tailoringSource === "ai" ? "accepted" : "rules");
            } else {
              const fresh = tailorProfileForJobWithAts(candidate, job);
              saveCachedTailoredResume(jobId, fresh, currentOwner);
              setTailoredResult(fresh);
              setAiStatus("rules");
            }
          })
          .catch(() => {
            if (activeOwnerIdRef.current !== currentOwner) return;
            const fresh = tailorProfileForJobWithAts(candidate, job);
            saveCachedTailoredResume(jobId, fresh, currentOwner);
            setTailoredResult(fresh);
            setAiStatus("rules");
          });
      }
    }
  }, [open, jobId, candidate, job, activeOwnerId]);

  const tailoredCandidate = tailoredResult.tailoredCandidate;
  const atsScore = tailoredResult.atsScore;
  const scoring = tailoredResult.scoringResult;
  const matchedKeywords = scoring.matchedKeywords;
  const missingKeywords = scoring.missingKeywords;

  const resumeText = useMemo(() => {
    return buildAtsResumePlainText(tailoredCandidate);
  }, [tailoredCandidate]);

  if (!open) return null;

  const handleGenerateAi = async () => {
    if (!isProUser) {
      toast.info("CareerMonke Pro subscription required for AI resume tailoring.");
      return;
    }
    const currentGen = ++authGenerationRef.current;
    const initialSessionUser = await getVerifiedSessionUserId();
    const capturedOwner = initialSessionUser ?? (userId === "guest" ? "guest" : null);

    // Stop safely when no owner is verified: do not generate or read/write cache
    if (!capturedOwner) {
      toast.error("Please sign in to generate tailored resume.");
      setAiStatus("rules");
      return;
    }

    activeOwnerIdRef.current = capturedOwner;
    setAiStatus("generating");
    setAiError(null);

    try {
      const res = await generateAiTailoredResume(candidate, job);

      const liveSessionUserId = await getVerifiedSessionUserId();
      const liveExpectedOwner = liveSessionUserId ?? (userId === "guest" ? "guest" : null);

      if (
        currentGen !== authGenerationRef.current ||
        capturedOwner !== liveExpectedOwner ||
        capturedOwner !== activeOwnerIdRef.current
      ) {
        console.warn("Auth changed during AI resume generation; discarding result to prevent cross-account contamination.");
        setAiStatus("rules");
        return;
      }

      if (!res.success || !res.draft) {
        setAiStatus("failed");
        const msg = res.error || "AI generation failed. Retaining verified rules-based resume.";
        setAiError(msg);
        toast.error(msg);
        return;
      }

      setPendingAiDraft({
        ...res.draft,
        modelIdentity: res.model,
        jobDescriptionShortened: res.jobDescriptionShortened,
        capturedOwnerId: capturedOwner,
        capturedGen: currentGen,
      });
      setAiStatus("reviewing");
      toast.info("AI draft generated! Review changes before accepting.");
    } catch (err: any) {
      setAiStatus("failed");
      const msg = err?.message || "Failed to reach AI service.";
      setAiError(msg);
      toast.error(msg);
    }
  };

  const handleAcceptAi = async () => {
    if (!pendingAiDraft) return;

    const liveSessionUserId = await getVerifiedSessionUserId();
    const liveExpectedOwner = liveSessionUserId ?? (userId === "guest" ? "guest" : null);

    if (
      !liveExpectedOwner ||
      (pendingAiDraft.capturedGen !== undefined && pendingAiDraft.capturedGen !== authGenerationRef.current) ||
      pendingAiDraft.capturedOwnerId !== liveExpectedOwner ||
      pendingAiDraft.capturedOwnerId !== activeOwnerIdRef.current
    ) {
      console.warn("Owner or generation changed before accepting draft; rejecting.");
      setPendingAiDraft(null);
      setAiStatus("rules");
      toast.error("Session changed; unable to save draft.");
      return;
    }

    const appliedCandidate = applyAcceptedAiDraft(candidate, pendingAiDraft);
    const recomputedAts = computeJobAtsScore(appliedCandidate, job);
    const sourceHash = computeResumeSourceHash(candidate, job, "1.0");

    const acceptedResult: TailoredJobResumeResult = {
      jobId,
      jobTitle: job.title,
      company: job.company,
      tailoredCandidate: appliedCandidate,
      atsScore: Math.max(0, Math.min(100, Math.round(recomputedAts.score))),
      scoringResult: recomputedAts,
      revisionAttempts: tailoredResult.revisionAttempts,
      tailoredAt: new Date().toISOString(),
      tailoringSource: "ai",
      sourceHash,
      operationVersion: "1.0",
      modelIdentity: pendingAiDraft.modelIdentity,
      jobDescriptionShortened: pendingAiDraft.jobDescriptionShortened,
      aiDraft: pendingAiDraft,
    };

    saveCachedTailoredResume(jobId, acceptedResult, liveExpectedOwner);
    setTailoredResult(acceptedResult);
    setAiStatus("accepted");
    setPendingAiDraft(null);
    toast.success("AI-tailored version accepted and applied to resume exports!");
  };

  const handleDiscardAi = () => {
    setPendingAiDraft(null);
    setAiStatus("rules");
    if (tailoredResult.tailoringSource === "ai") {
      const rulesResult = tailorProfileForJobWithAts(candidate, job);
      if (activeOwnerId) {
        saveCachedTailoredResume(jobId, rulesResult, activeOwnerId);
      }
      setTailoredResult(rulesResult);
    }
    toast.info("Retained verified rules-based resume.");
  };

  const verifyExportAllowed = async (): Promise<boolean> => {
    if (userId === "guest") return true;
    const liveSessionUser = await getVerifiedSessionUserId();
    if (!liveSessionUser || liveSessionUser !== activeOwnerIdRef.current) {
      toast.error("Please sign in with your active account to export tailored documents.");
      return false;
    }
    return true;
  };

  const handleDownloadPdf = async () => {
    if (!(await verifyExportAllowed())) return;
    const filename = `${(candidate.name || "Resume").replace(/\s+/g, "_")}_Tailored_${(job.company || "Company").replace(/\s+/g, "_")}_${(job.title || "Role").replace(/\s+/g, "_")}_ATS.pdf`;
    downloadAtsResumePdf(tailoredCandidate, filename);
    toast.success(`Downloaded ATS PDF tailored for ${job.company}!`);
  };

  const handleDownloadDocx = async () => {
    if (!(await verifyExportAllowed())) return;
    const filename = `${(candidate.name || "Resume").replace(/\s+/g, "_")}_Tailored_${(job.company || "Company").replace(/\s+/g, "_")}_${(job.title || "Role").replace(/\s+/g, "_")}_ATS.docx`;
    downloadAtsResumeDocx(tailoredCandidate, filename);
    toast.success(`Downloaded ATS Word document tailored for ${job.company}!`);
  };

  const handleDownloadTxt = async () => {
    if (!(await verifyExportAllowed())) return;
    const filename = `${(candidate.name || "Resume").replace(/\s+/g, "_")}_Tailored_${(job.company || "Company").replace(/\s+/g, "_")}_${(job.title || "Role").replace(/\s+/g, "_")}_ATS.txt`;
    downloadAtsResumeText(tailoredCandidate, filename);
    toast.success("Downloaded plain text ATS resume!");
  };

  const handleCopy = async () => {
    if (!(await verifyExportAllowed())) return;
    navigator.clipboard.writeText(resumeText);
    setCopied(true);
    toast.success("Tailored resume copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRerun = () => {
    const fresh = tailorProfileForJobWithAts(candidate, job);
    saveCachedTailoredResume(jobId, fresh, activeOwnerId);
    setTailoredResult(fresh);
    setAiStatus("rules");
    setPendingAiDraft(null);
    setAiError(null);
    toast.success("Re-tailored resume against job description!");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
      <div
        className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh] animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex items-start justify-between relative">
          <div className="pr-8 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                <Sparkles className="w-3.5 h-3.5" /> ATS keyword match estimate: {atsScore}/100
              </span>
              {tailoredResult.tailoringSource === "ai" ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-purple-500/30 text-purple-200 border border-purple-400/40">
                  <Sparkles className="w-3 h-3 text-purple-300" /> AI-tailored accepted
                </span>
              ) : aiStatus === "reviewing" ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-500/30 text-blue-200 border border-blue-400/40">
                  AI draft awaiting review
                </span>
              ) : aiStatus === "generating" ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/30 text-amber-200 border border-amber-400/40 animate-pulse">
                  AI generating...
                </span>
              ) : aiStatus === "failed" ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/30 text-rose-200 border border-rose-400/40">
                  AI generation failed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-500/20 text-slate-300 border border-slate-500/40">
                  Rules-based
                </span>
              )}
              <span className="text-xs text-slate-400 font-mono hidden sm:inline">• Profile Grounded</span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white line-clamp-1">{job.title}</h2>
            <p className="text-xs sm:text-sm text-slate-300">
              {job.company} • {job.location || "Remote"}
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

        {/* Scrollable Body */}
        <div className="p-5 sm:p-6 space-y-5 overflow-y-auto flex-1">
          {/* ATS Performance Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 border border-emerald-500/30 text-white shadow-md space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <div className="w-13 h-13 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex flex-col items-center justify-center text-center shrink-0">
                  <span className="text-xl font-black text-emerald-400 leading-none">{atsScore}</span>
                  <span className="text-[9px] font-bold text-emerald-300 uppercase tracking-wider mt-0.5">ATS</span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white">ATS Keyword Match Estimate</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-slate-800 text-emerald-300 border border-emerald-500/40 uppercase tracking-wider">
                      {atsScore}/100
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">
                    Estimated keyword overlap with {job.company}&apos;s {job.title} listing ({matchedKeywords.length} matched, {missingKeywords.length} missing). Automated estimate; does not evaluate candidate quality, hiring probability, or factual truth.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleRerun}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-300 hover:text-emerald-200 transition-colors cursor-pointer bg-white/5 hover:bg-white/10 px-2.5 py-1 rounded-lg border border-emerald-500/30"
              >
                <RotateCw className="w-3 h-3" />
                <span>Re-check ATS</span>
              </button>
            </div>

            {/* Score breakdown metrics */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800 text-center">
              <div className="p-2 rounded-xl bg-white/5 border border-white/5">
                <div className="text-[10px] text-slate-400">JD Keywords</div>
                <div className="text-sm font-bold text-emerald-400">{scoring.breakdown.keywordScore}%</div>
              </div>
              <div className="p-2 rounded-xl bg-white/5 border border-white/5">
                <div className="text-[10px] text-slate-400">Skills Coverage</div>
                <div className="text-sm font-bold text-emerald-400">{scoring.breakdown.skillsScore}%</div>
              </div>
              <div className="p-2 rounded-xl bg-white/5 border border-white/5">
                <div className="text-[10px] text-slate-400">Role Alignment</div>
                <div className="text-sm font-bold text-emerald-400">{scoring.breakdown.titleScore}%</div>
              </div>
            </div>
          </div>

          {/* AI Tailoring Control & Review Section */}
          <div className="space-y-3">
            {aiStatus === "rules" && (
              !isProUser ? (
                <LockedPreview
                  title="Unlock AI Resume Tailoring"
                  subtitle="Your resume has gaps. See exactly which ones. AI resume tailoring aligns your keywords directly to this role."
                  ctaText="Unlock AI tailoring"
                  ctaHref="/pricing"
                  badge="PRO FEATURE"
                  blurIntensity="sm"
                  minHeight="min-h-[140px]"
                >
                  <div className="p-4 rounded-xl bg-gradient-to-r from-blue-50 via-indigo-50 to-purple-50 border border-indigo-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                        <span>Generate AI-tailored version</span>
                      </div>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Aligns summary and experience bullets with target job criteria and keywords.
                      </p>
                    </div>
                    <div className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold shadow-xs">
                      Generate AI-tailored version
                    </div>
                  </div>
                </LockedPreview>
              ) : (
                <div className="p-4 rounded-xl bg-gradient-to-r from-blue-50 via-indigo-50 to-purple-50 border border-indigo-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                      <Sparkles className="w-4 h-4 text-indigo-600" />
                      <span>Generate AI-tailored version</span>
                    </div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Currently using deterministic rules and templates based on your verified resume. Click to generate an AI rewrite aligned with target role criteria (uses 1 of your 30 daily tailoring allowance).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateAi}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white text-xs font-bold shadow-xs transition flex items-center gap-1.5 shrink-0 cursor-pointer min-h-[44px]"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Generate AI-tailored version</span>
                  </button>
                </div>
              )
            )}

            {aiStatus === "generating" && (
              <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center gap-3">
                <RotateCw className="w-4 h-4 text-indigo-600 animate-spin shrink-0" />
                <div>
                  <p className="text-xs font-bold text-indigo-950">Generating AI-tailored draft...</p>
                  <p className="text-[11px] text-indigo-700">Strictly aligning summary and bullets with target job without inventing facts.</p>
                </div>
              </div>
            )}

            {aiStatus === "failed" && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start justify-between gap-2.5">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="font-bold">AI generation failed: {aiError || "Service temporarily unavailable."}</p>
                    <p className="text-[11px] text-rose-700">Your verified rules-based resume remains active and safe to export.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateAi}
                  className="px-3 py-1.5 bg-white hover:bg-rose-100 text-rose-700 rounded-lg border border-rose-300 text-xs font-semibold cursor-pointer shrink-0"
                >
                  Retry AI
                </button>
              </div>
            )}

            {aiStatus === "reviewing" && pendingAiDraft && (
              <div className="p-4 sm:p-5 rounded-2xl bg-white border-2 border-indigo-400 shadow-md space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
                    <div>
                      <span className="text-sm font-bold text-slate-900 block">AI Draft Awaiting Review</span>
                      <span className="text-[11px] text-slate-600">
                        AI models can overstate experience. Carefully review each rewritten line below before deciding to accept.
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDiscardAi}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer min-h-[36px]"
                    >
                      Discard / Keep Rules
                    </button>
                    <button
                      type="button"
                      onClick={handleAcceptAi}
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs cursor-pointer flex items-center gap-1 min-h-[36px]"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Accept AI Changes</span>
                    </button>
                  </div>
                </div>

                {pendingAiDraft.jobDescriptionShortened && (
                  <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                    Warning: Target job description was shortened to fit token limits. Core role criteria were retained.
                  </div>
                )}

                {/* Summary Comparison */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Professional Summary</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                      <div className="font-semibold text-slate-500 uppercase text-[10px]">Original Summary</div>
                      <p className="text-slate-700">{candidate.summary || "(No summary provided)"}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-1">
                      <div className="font-semibold text-indigo-700 uppercase text-[10px] flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> AI Tailored Summary
                      </div>
                      <p className="text-slate-900 font-medium">{pendingAiDraft.tailoredSummary}</p>
                    </div>
                  </div>
                </div>

                {/* Experience Bullets Comparison */}
                {Object.entries(pendingAiDraft.tailoredBullets).length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Work Experience Bullets</h4>
                    {Object.entries(pendingAiDraft.tailoredBullets).map(([expId, rewrittenBullets]) => {
                      const origExp = (candidate.experience || []).find((e, idx) => (e.id || `exp-${idx + 1}`) === expId);
                      const origBullets = origExp?.bullets || [];
                      return (
                        <div key={expId} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                          <div className="font-bold text-slate-800">
                            {origExp?.role || "Role"} at {origExp?.company || "Company"}
                          </div>
                          <div className="space-y-2">
                            {rewrittenBullets.map((newBullet, bIdx) => (
                              <div key={bIdx} className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                                <div className="p-2 rounded-lg bg-white border border-slate-200 text-slate-600">
                                  <span className="font-semibold text-slate-400 block text-[9px] uppercase">Original Bullet {bIdx + 1}</span>
                                  {origBullets[bIdx] || "(None)"}
                                </div>
                                <div className="p-2 rounded-lg bg-indigo-50 border border-indigo-200 text-slate-900 font-medium">
                                  <span className="font-semibold text-indigo-600 block text-[9px] uppercase flex items-center gap-1">
                                    <Sparkles className="w-2.5 h-2.5" /> Rewritten Bullet {bIdx + 1}
                                  </span>
                                  {newBullet}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {aiStatus === "accepted" && tailoredResult.tailoringSource === "ai" && (
              <div className="p-3.5 rounded-xl bg-purple-50 border border-purple-200 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-600 shrink-0" />
                  <div>
                    <span className="font-bold text-purple-950">AI-tailored version accepted</span>
                    <span className="text-[11px] text-purple-700 block">
                      Active in preview and export downloads (.pdf, .docx, .txt).
                      {tailoredResult.modelIdentity ? ` Model: ${tailoredResult.modelIdentity}.` : ""}
                      {" "}AI can overstate experience; please confirm all claims reflect your actual background.
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleGenerateAi}
                    className="px-2.5 py-1 rounded-lg bg-white hover:bg-purple-100 text-purple-800 border border-purple-300 text-xs font-semibold cursor-pointer"
                  >
                    Re-generate AI
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardAi}
                    className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
                  >
                    Revert to Rules
                  </button>
                </div>
              </div>
            )}
            {tailoredResult.jobDescriptionShortened && aiStatus !== "reviewing" && (
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                Warning: Target job description was shortened to fit token limits. Core role criteria were retained.
              </div>
            )}
          </div>

          {/* Explanation Banner */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-bold text-slate-900">
                {tailoredResult.tailoringSource === "ai" || aiStatus === "reviewing"
                  ? "AI Tailoring Advisory & Verification"
                  : "Deterministic Rules-Based Resume Alignment"}
              </p>
              <p className="text-slate-600">
                {tailoredResult.tailoringSource === "ai" || aiStatus === "reviewing"
                  ? "AI models can overstate experience and introduce subtle inaccuracies. Each line needs candidate review before submitting. The ATS score is an estimate of keyword overlap and does not prove candidate quality, hiring probability, or factual truth."
                  : `This version uses your existing resume content organized with deterministic rules and templates based on your verified background, not AI writing. The score estimates keyword overlap with ${job.company}'s listing and does not guarantee interviews or employment.`}
              </p>
            </div>
          </div>

          {/* Matched Keywords Highlighting */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Matched Keywords Prioritized in Export ({matchedKeywords.length})</span>
              </h3>
              <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                Promoted to Front of ATS Parsing
              </span>
            </div>

            <div className="p-3.5 bg-emerald-50/50 rounded-xl border border-emerald-100 flex flex-wrap gap-1.5">
              {matchedKeywords.length > 0 ? (
                matchedKeywords.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-white text-emerald-800 border border-emerald-200 shadow-2xs"
                  >
                    ✓ {s}
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-500 italic">
                  No direct keyword overlap found with this job description. Your full verified skill list will still be exported.
                </span>
              )}
            </div>
          </div>

          {/* Missing Keywords Section */}
          {missingKeywords.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <span>Job Keywords Missing from Profile ({missingKeywords.length})</span>
              </h3>
              <div className="p-3.5 bg-amber-50/50 rounded-xl border border-amber-200 flex flex-wrap gap-1.5">
                {missingKeywords.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-white text-amber-900 border border-amber-200"
                  >
                    + {s}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 italic">
                These keywords were found in the job listing. Prepare to discuss relevant project exposure during interviews.
              </p>
            </div>
          )}

          {/* Preview Toggle & Plain Text Box */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowFullPreview(!showFullPreview)}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>{showFullPreview ? "Hide Resume Preview" : "View Tailored ATS Text Preview"}</span>
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied!" : "Copy Text"}</span>
              </button>
            </div>

            {showFullPreview && (
              <div className="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap border border-slate-800">
                {resumeText}
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {onOpenCoverLetter && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onOpenCoverLetter();
                }}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer py-2 px-1"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Need Cover Letter Instead? →</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={handleDownloadTxt}
              className="px-3 py-2.5 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition cursor-pointer min-h-[44px] flex items-center gap-1.5"
            >
              <FileCode className="w-3.5 h-3.5 text-slate-500" />
              <span>Text (.txt)</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadDocx}
              className="px-3 py-2.5 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition cursor-pointer min-h-[44px] flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>Word (.docx)</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadPdf}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-xs font-bold shadow-xs transition cursor-pointer min-h-[44px] flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              <span>Download PDF (.pdf)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
