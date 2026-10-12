"use client";

import React, { useState, useEffect } from "react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import { getCandidateProfile, deleteCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import {
  FileText,
  ShieldCheck,
  Download,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileCheck
} from "lucide-react";
import { toast } from "react-toastify";
import { useRouter } from "next/navigation";

export default function ResumePage() {
  const router = useRouter();
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = async (userId?: string) => {
    try {
      const [proRes, cp] = await Promise.all([
        getProAccessStatus(userId),
        getCandidateProfile(userId),
      ]);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      if (cp && cp.confirmedAt) {
        setCandidate(cp);
      } else {
        setCandidate(null);
      }
    } catch {
      setCandidate(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?next=/resume");
        return;
      }
      loadData(u.id);
    });

    const handleUpdate = () => {
      getAuthUser().then((u) => {
        if (u) loadData(u.id);
      });
    };
    window.addEventListener("careermonke_profile_updated", handleUpdate);
    return () => window.removeEventListener("careermonke_profile_updated", handleUpdate);
  }, [router]);

  const handleDeleteProfile = async () => {
    if (!window.confirm("Are you sure you want to delete your confirmed resume facts? This will reset all personalized match scores.")) {
      return;
    }
    await deleteCandidateProfile();
    setCandidate(null);
    toast.info("Resume facts deleted. Personalized match scores reset.");
  };

  if (loading || (!isPro && !isProDefinitive)) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between">
        <GuideHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </main>
        <Footer />
      </div>
    );
  }

  // Definitively non-Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between">
        <GuideHeader />
        <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 w-full">
          <ProUpgradeScreen
            title="Unlock CareerMonke Pro"
            subtitle="Upgrade to Pro to upload your resume, compute compatibility scores, and generate AI tailored applications."
          />
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col justify-between selection:bg-blue-100 selection:text-blue-900">
      <GuideHeader />

      <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 w-full space-y-8">
        {/* Header Ribbon */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Resume & Fact Profile
              </h1>
              {candidate ? (
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Confirmed Facts</span>
                </span>
              ) : (
                <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  No Resume Uploaded
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Verified fact extraction with zero invented achievements. Review and confirm facts before saving.
            </p>
          </div>

          {candidate && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDeleteProfile}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Facts</span>
              </button>
            </div>
          )}
        </div>

        {/* Fact Parser & Review Interface */}
        <section>
          <ResumeUploadAndConfirm onProfileConfirmed={(cp: CandidateProfile) => setCandidate(cp)} />
        </section>

        {/* Explanation on Job Tailoring */}
        <section className="bg-white rounded-2xl p-6 border border-slate-200 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <FileCheck className="w-4 h-4 text-blue-600" />
            <span>Role-Specific Resumes & Cover Letters</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            AI resume tools are applied directly to specific roles. From your{" "}
            <a href="/dashboard" className="text-blue-600 font-semibold hover:underline">
              Top 10 Jobs
            </a>
            {" "}or the{" "}
            <a href="/jobs" className="text-blue-600 font-semibold hover:underline">
              Jobs Feed
            </a>
            , click <strong>&quot;AI Resume&quot;</strong> or <strong>&quot;Cover Letter&quot;</strong>. All generated content is strictly grounded in your confirmed profile facts.
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
