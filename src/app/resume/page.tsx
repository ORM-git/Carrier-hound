"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import AppIconRail from "@/components/shell/AppIconRail";
import AppTopBar from "@/components/shell/AppTopBar";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import {
  getCandidateProfile,
  deleteCandidateProfile,
  saveCandidateProfileLocally,
  saveCandidateProfileToSupabase,
} from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { downloadAtsResumeDocx, downloadAtsResumeText } from "@/lib/resume/tailor";
import type { User } from "@supabase/supabase-js";
import {
  FileText,
  Download,
  Trash2,
  UploadCloud,
  CheckCircle2,
  Eye,
  EyeOff,
  Edit3,
  X,
  MapPin,
  Mail,
  Phone,
  Briefcase,
  GraduationCap,
  Sparkles,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
} from "lucide-react";

function ResumeSkeleton({ user, isPro }: { user?: User | null; isPro?: boolean }) {
  return (
    <LoggedInAppShell pageLabel="RESUME" user={user} isPro={isPro}>
      <div className="max-w-[1176px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-[#E2E8F0]">
          <div className="h-8 w-36 bg-[#E2E8F0] animate-pulse rounded-full" />
          <div className="h-10 w-36 bg-[#E2E8F0] animate-pulse rounded-full" />
        </div>
        <div className="h-28 w-full bg-white rounded-[16px] ring-1 ring-[#E2E8F0] animate-pulse" />
      </div>
          </LoggedInAppShell>
  );
}

function formatTimeAgo(dateStr?: string): string {
  if (!dateStr) return "Recently";
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

export default function ResumePage() {
  const router = useRouter();

  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  // Resume card state
  const [resumeTitle, setResumeTitle] = useState<string>("Master Resume");
  const [isViewDetailsOpen, setIsViewDetailsOpen] = useState<boolean>(false);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState<boolean>(false);
  const [renameInput, setRenameInput] = useState<string>("");
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    if (isMenuOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isMenuOpen]);

  const loadData = useCallback(async (userId?: string) => {
    try {
      const [proRes, cp] = await Promise.all([
        getProAccessStatus(userId),
        getCandidateProfile(userId),
      ]);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      if (cp && cp.confirmedAt) {
        setCandidate(cp);
        if (typeof window !== "undefined") {
          const savedLabel = localStorage.getItem("careermonke_resume_title");
          if (savedLabel) {
            setResumeTitle(savedLabel);
          } else if (cp.name) {
            setResumeTitle(`${cp.name} - Resume`);
          }
        }
      } else {
        setCandidate(null);
      }
    } catch {
      setCandidate(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?returnTo=/resume");
        return;
      }
      setUser(u);
      loadData(u.id);
    });

    const handleUpdate = () => {
      getAuthUser().then((u) => {
        if (u) {
          setUser(u);
          loadData(u.id);
        }
      });
    };
    window.addEventListener("careermonke_profile_updated", handleUpdate);
    return () => window.removeEventListener("careermonke_profile_updated", handleUpdate);
  }, [router, loadData]);

  const handleDeleteProfile = async () => {
    if (
      !window.confirm(
        "Are you sure you want to delete your confirmed resume facts? This will reset all personalized match scores."
      )
    ) {
      return;
    }
    await deleteCandidateProfile();
    setCandidate(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem("careermonke_resume_title");
    }
    setIsMenuOpen(false);
    toast.info("Resume facts deleted. Personalized match scores reset.");
  };

  const handleOpenRename = () => {
    setRenameInput(resumeTitle);
    setIsRenameModalOpen(true);
    setIsMenuOpen(false);
  };

  const handleSaveRename = async () => {
    const trimmed = renameInput.trim();
    if (!trimmed) {
      toast.error("Resume title cannot be empty.");
      return;
    }
    setResumeTitle(trimmed);
    if (typeof window !== "undefined") {
      localStorage.setItem("careermonke_resume_title", trimmed);
    }
    if (candidate) {
      const updated: CandidateProfile = {
        ...candidate,
        updatedAt: new Date().toISOString(),
      };
      setCandidate(updated);
      saveCandidateProfileLocally(updated);
      await saveCandidateProfileToSupabase(updated);
    }
    setIsRenameModalOpen(false);
    toast.success("Resume renamed successfully");
  };

  const handleProfileConfirmed = (cp: CandidateProfile) => {
    setCandidate(cp);
    const newTitle = cp.name ? `${cp.name} - Resume` : "Master Resume";
    setResumeTitle(newTitle);
    if (typeof window !== "undefined") {
      localStorage.setItem("careermonke_resume_title", newTitle);
    }
    setIsUploadModalOpen(false);
    toast.success("Resume facts confirmed successfully!");
  };

  if (loading || (!isPro && !isProDefinitive)) {
    return <ResumeSkeleton user={user} isPro={isPro} />;
  }

  // Definitively non-Pro
  if (!isPro) {
    return (
      <LoggedInAppShell pageLabel="RESUME" user={user} isPro={false}>
        <div className="max-w-[1176px] mx-auto px-4 sm:px-6 py-8 w-full">
          <ProUpgradeScreen
            title="Unlock CareerMonke Pro"
            subtitle="Upgrade to Pro to upload your resume, compute compatibility scores, and generate AI tailored applications."
          />
        </div>
              </LoggedInAppShell>
    );
  }

  const isConfirmed = Boolean(candidate && candidate.confirmedAt);
  const uploadedDateStr = candidate?.confirmedAt || candidate?.updatedAt;
  const formattedDate = uploadedDateStr
    ? new Date(uploadedDateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Recently";
  const createdAgo = formatTimeAgo(candidate?.confirmedAt || candidate?.updatedAt);
  const lastModifiedAgo = formatTimeAgo(candidate?.updatedAt || candidate?.confirmedAt);

  const initialLetter = (
    candidate?.name?.trim().charAt(0) ||
    user?.email?.charAt(0) ||
    "A"
  ).toUpperCase();

  return (
    <LoggedInAppShell pageLabel="RESUME" user={user} isPro={isPro}>
      <div className="w-full max-w-[1176px] mx-auto px-4 lg:px-0 py-6 sm:py-8 space-y-6">
        {/* ================================================================= */}
        {/* PAGE HEADER: "RESUME" bold 24px                                   */}
        {/* ================================================================= */}
        <div
          data-testid="resume-page-header"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#E2E8F0]"
        >
          <div>
            <h1 className="text-[24px] font-extrabold text-[#0F172A] tracking-tight">
              RESUME <span className="sr-only">Resumes</span>
            </h1>
            <p className="text-[13px] text-[#475569] mt-0.5">
              Manage your verified resumes and confirmed background facts for automated matching.
            </p>
          </div>
        </div>

        {/* ================================================================= */}
        {/* INFO ROW: Verified resume status & single + Add Resume entry point*/}
        {/* ================================================================= */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-1 text-[14px] font-medium text-[#0F172A]">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB] flex items-center justify-center text-xs font-bold shrink-0">
              💬
            </span>
            <span>
              {candidate && candidate.confirmedAt
                ? "You have 1 verified resume active for AI tailoring and fit scoring."
                : candidate
                ? "Resume facts need review before AI tailoring and fit scoring are active."
                : "No active resume. Upload a resume to ground AI tailoring and fit scoring."}
            </span>
            <span
              title="CareerMonke uses your confirmed resume facts to calculate match scores and tailor applications."
              className="text-[#64748B] hover:text-[#0F172A] cursor-help inline-flex items-center"
            >
              ⓘ
            </span>
          </div>

          <button
            type="button"
            data-testid="upload-resume-button"
            onClick={() => setIsUploadModalOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] text-[13px] font-semibold text-[#0F172A] transition shadow-2xs self-start sm:self-auto cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
          >
            <span className="w-4 h-4 rounded bg-[#EFF6FF] text-[#2563EB] flex items-center justify-center font-bold text-xs">
              +
            </span>
            <span>Add Resume</span>
          </button>
        </div>

        {/* ================================================================= */}
        {/* RESUMES TABLE CARD (Measured: 1176px w, 16px radius, 80px row)    */}
        {/* ================================================================= */}
        {candidate ? (
          <div
            data-testid="resume-list-container"
            className="space-y-4"
          >
            <div
              data-testid="resume-card"
              className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] shadow-none overflow-hidden"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="h-[49px] border-b border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] bg-white">
                      <th className="py-3 px-3 sm:px-6 font-semibold">Resume</th>
                      <th className="py-3 px-4 font-semibold hidden md:table-cell">Target Job Title</th>
                      <th className="py-3 px-4 font-semibold hidden lg:table-cell">Last Modified</th>
                      <th className="py-3 px-4 font-semibold hidden sm:table-cell">Created</th>
                      <th className="py-3 px-3 sm:px-6 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="h-[80px] border-b border-[#E2E8F0] last:border-b-0 hover:bg-[#F8FAFC]/80 transition-colors">
                      {/* Column 1: Resume */}
                      <td className="py-2.5 px-3 sm:px-6 align-middle">
                        <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
                          {/* Hexagon/Tile Avatar */}
                          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center text-[#2563EB] font-bold text-[14px] sm:text-[15px] shrink-0">
                            {initialLetter}
                          </div>

                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-2">
                              <h3 className="text-[14px] sm:text-[15px] font-bold text-[#0F172A] truncate max-w-[130px] sm:max-w-[280px]">
                                {resumeTitle}
                              </h3>

                              {/* PRIMARY Pill */}
                              <span
                                title="Primary resume used for match scoring and recommendations"
                                className="inline-flex items-center gap-0.5 sm:gap-1 text-[10px] sm:text-[11px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#2563EB] border border-[#BFDBFE] shrink-0 whitespace-nowrap"
                              >
                                <span>★</span>
                                <span>PRIMARY</span>
                                <span className="text-[10px] text-[#2563EB]">ⓘ</span>
                              </span>
                            </div>

                            <div className="text-[13px] text-[#64748B] flex items-center gap-2 flex-wrap">
                              <span>Uploaded {formattedDate}</span>
                              {candidate.name && (
                                <>
                                  <span>•</span>
                                  <span className="text-[#475569] truncate max-w-[120px]">{candidate.name}</span>
                                </>
                              )}
                              {/* Status Chip */}
                              {isConfirmed ? (
                                <span
                                  data-testid="resume-status-chip"
                                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#DCFCE7] text-[#166534] border border-[#BBF7D0] inline-flex items-center"
                                >
                                  Confirmed · Analysis Complete
                                </span>
                              ) : (
                                <span
                                  data-testid="resume-status-chip"
                                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#FEF3C7] text-[#92400E] border border-[#FDE68A] inline-flex items-center"
                                >
                                  Needs review
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Column 2: Target Job Title */}
                      <td className="py-2.5 px-4 align-middle hidden md:table-cell text-[13px] text-[#475569]">
                        <span className="truncate block max-w-[180px]">
                          {candidate.headline || candidate.experience?.[0]?.role || "—"}
                        </span>
                      </td>

                      {/* Column 3: Last Modified */}
                      <td className="py-2.5 px-4 align-middle hidden lg:table-cell text-[13px] text-[#64748B]">
                        {lastModifiedAgo}
                      </td>

                      {/* Column 4: Created */}
                      <td className="py-2.5 px-4 align-middle hidden sm:table-cell text-[13px] text-[#64748B]">
                        {createdAgo}
                      </td>

                      {/* Column 5: Action Menu */}
                      <td className="py-2.5 px-3 sm:px-6 align-middle text-right">
                        <div
                          ref={menuRef}
                          data-testid="resume-actions-row"
                          className="relative inline-flex items-center gap-0.5 sm:gap-1 justify-end"
                        >
                          {/* Direct icon buttons for quick access & strict test suite contract */}
                          <button
                            type="button"
                            onClick={() => setIsViewDetailsOpen(!isViewDetailsOpen)}
                            title={isViewDetailsOpen ? "Hide preview" : "View details"}
                            aria-label="View resume details"
                            className="p-1.5 rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition cursor-pointer"
                          >
                            {isViewDetailsOpen ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>

                          <button
                            type="button"
                            onClick={handleOpenRename}
                            title="Rename resume"
                            aria-label="Rename resume"
                            className="p-1.5 rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition cursor-pointer"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>

                          <button
                            type="button"
                            onClick={handleDeleteProfile}
                            title="Delete resume facts"
                            aria-label="Delete resume"
                            className="p-1.5 rounded-full text-[#475569] hover:text-[#DC2626] hover:bg-[#FEE2E2] transition cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>

                          {/* "..." More menu button matching target reference */}
                          <button
                            type="button"
                            onClick={() => setIsMenuOpen(!isMenuOpen)}
                            aria-label="More options"
                            title="More options"
                            className="p-1.5 rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition cursor-pointer"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>

                          {/* Dropdown Menu */}
                          {isMenuOpen && (
                            <div className="absolute right-0 top-full mt-1.5 w-48 bg-white rounded-xl shadow-lg ring-1 ring-[#E2E8F0] py-1.5 z-30 text-left animate-fadeIn">
                              <button
                                type="button"
                                onClick={() => {
                                  setIsViewDetailsOpen(!isViewDetailsOpen);
                                  setIsMenuOpen(false);
                                }}
                                className="w-full px-3.5 py-2 text-[13px] text-[#0F172A] hover:bg-[#F8FAFC] flex items-center gap-2"
                              >
                                <Eye className="w-4 h-4 text-[#64748B]" />
                                <span>{isViewDetailsOpen ? "Hide Preview" : "View Preview"}</span>
                              </button>
                              <button
                                type="button"
                                onClick={handleOpenRename}
                                className="w-full px-3.5 py-2 text-[13px] text-[#0F172A] hover:bg-[#F8FAFC] flex items-center gap-2"
                              >
                                <Edit3 className="w-4 h-4 text-[#64748B]" />
                                <span>Rename Resume</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  downloadAtsResumeDocx(candidate);
                                  setIsMenuOpen(false);
                                }}
                                className="w-full px-3.5 py-2 text-[13px] text-[#0F172A] hover:bg-[#F8FAFC] flex items-center gap-2"
                              >
                                <Download className="w-4 h-4 text-[#2563EB]" />
                                <span>Export Word (.docx)</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  downloadAtsResumeText(candidate);
                                  setIsMenuOpen(false);
                                }}
                                className="w-full px-3.5 py-2 text-[13px] text-[#0F172A] hover:bg-[#F8FAFC] flex items-center gap-2"
                              >
                                <FileText className="w-4 h-4 text-[#64748B]" />
                                <span>Export Text (.txt)</span>
                              </button>
                              <div className="border-t border-[#E2E8F0] my-1" />
                              <button
                                type="button"
                                onClick={handleDeleteProfile}
                                className="w-full px-3.5 py-2 text-[13px] text-[#DC2626] hover:bg-[#FEE2E2] flex items-center gap-2"
                              >
                                <Trash2 className="w-4 h-4 text-[#DC2626]" />
                                <span>Delete Resume</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Expanded Details Section when View action is active */}
              {isViewDetailsOpen && (
                <div
                  data-testid="resume-view-details"
                  className="p-5 border-t border-[#E2E8F0] space-y-4 bg-[#F8FAFC] animate-fadeIn"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="space-y-1">
                      <h4 className="text-[16px] font-bold text-[#0F172A]">
                        {candidate.name || "Candidate Profile"}
                      </h4>
                      {candidate.headline && (
                        <p className="text-[13px] font-medium text-[#2563EB]">
                          {candidate.headline}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#475569] pt-1">
                        {candidate.location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-[#94A3B8]" />
                            <span>{candidate.location}</span>
                          </span>
                        )}
                        {candidate.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5 text-[#94A3B8]" />
                            <span>{candidate.email}</span>
                          </span>
                        )}
                        {candidate.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="w-3.5 h-3.5 text-[#94A3B8]" />
                            <span>{candidate.phone}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Quick ATS Export Actions */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => downloadAtsResumeDocx(candidate)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white border border-[#E2E8F0] hover:bg-[#F1F5F9] text-[#0F172A] text-[12px] font-semibold min-h-[36px] transition cursor-pointer shadow-2xs"
                        title="Export ATS-Friendly Word Document (.docx)"
                      >
                        <Download className="w-3.5 h-3.5 text-[#2563EB]" />
                        <span>Export Word (.docx)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadAtsResumeText(candidate)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white border border-[#E2E8F0] hover:bg-[#F1F5F9] text-[#0F172A] text-[12px] font-semibold min-h-[36px] transition cursor-pointer shadow-2xs"
                        title="Export Plain Text (.txt)"
                      >
                        <FileText className="w-3.5 h-3.5 text-[#475569]" />
                        <span>Export Text</span>
                      </button>
                    </div>
                  </div>

                  {/* Quick metrics counters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[#E2E8F0]">
                    <div className="p-2.5 rounded-[12px] bg-white border border-[#E2E8F0]">
                      <span className="text-[11px] text-[#475569] font-medium">Skills Identified</span>
                      <p className="text-[14px] font-bold text-[#0F172A]">{candidate.skills?.length || 0}</p>
                    </div>
                    <div className="p-2.5 rounded-[12px] bg-white border border-[#E2E8F0]">
                      <span className="text-[11px] text-[#475569] font-medium">Work History</span>
                      <p className="text-[14px] font-bold text-[#0F172A]">{candidate.experience?.length || 0} roles</p>
                    </div>
                    <div className="p-2.5 rounded-[12px] bg-white border border-[#E2E8F0]">
                      <span className="text-[11px] text-[#475569] font-medium">Education</span>
                      <p className="text-[14px] font-bold text-[#0F172A]">{candidate.education?.length || 0} entries</p>
                    </div>
                    <div className="p-2.5 rounded-[12px] bg-white border border-[#E2E8F0]">
                      <span className="text-[11px] text-[#475569] font-medium">Status</span>
                      <p className="text-[14px] font-bold text-[#166534]">Confirmed</p>
                    </div>
                  </div>

                  {/* Top Skills Preview */}
                  {candidate.skills && candidate.skills.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#64748B]">
                        Extracted Core Competencies
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {candidate.skills.slice(0, 12).map((skill, idx) => (
                          <span
                            key={idx}
                            className="text-[12px] bg-white text-[#475569] px-2.5 py-0.5 rounded-full border border-[#E2E8F0]"
                          >
                            {skill}
                          </span>
                        ))}
                        {candidate.skills.length > 12 && (
                          <span className="text-[12px] bg-white text-[#475569] px-2.5 py-0.5 rounded-full border border-[#E2E8F0]">
                            +{candidate.skills.length - 12} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* =============================================================== */
          /* EMPTY STATE: centred icon, one line, upload button               */
          /* =============================================================== */
          <div
            data-testid="resume-empty-state"
            className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-12 sm:p-16 text-center space-y-4 max-w-xl mx-auto shadow-none"
          >
            <div className="w-14 h-14 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB] mx-auto flex items-center justify-center">
              <FileText className="w-7 h-7 text-[#2563EB]" />
            </div>

            <div className="space-y-1">
              <h3 className="text-[16px] font-bold text-[#0F172A]">
                No resumes uploaded yet
              </h3>
              <p className="text-[13px] text-[#475569]">
                Upload your resume in PDF, DOCX, or TXT format to compute personalized compatibility scores.
              </p>
            </div>

            <div className="pt-2">
              <button
                type="button"
                data-testid="empty-upload-resume-button"
                onClick={() => setIsUploadModalOpen(true)}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white font-bold text-[14px] transition cursor-pointer shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1"
              >
                <UploadCloud className="w-4 h-4" />
                <span>Upload resume</span>
              </button>
            </div>
          </div>
        )}

        {/* Explanation on Job Tailoring */}
        <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 sm:p-5 shadow-none space-y-1.5">
          <div className="flex items-center gap-2 text-[#0F172A] font-bold text-[14px]">
            <Sparkles className="w-4 h-4 text-[#2563EB]" />
            <span>Role-Specific Resumes & Cover Letters</span>
          </div>
          <p className="text-[13px] text-[#475569] leading-relaxed">
            AI resume tools are applied directly to specific roles. From your{" "}
            <Link href="/dashboard" className="text-[#2563EB] font-semibold hover:underline">
              Top 10 Jobs
            </Link>{" "}
            or the{" "}
            <Link href="/jobs" className="text-[#2563EB] font-semibold hover:underline">
              Jobs Feed
            </Link>
            , click <strong>&quot;AI Resume&quot;</strong> or <strong>&quot;Cover Letter&quot;</strong>. All generated content is strictly grounded in your confirmed profile facts.
          </p>
        </div>
      </div>

      
      {/* =================================================================== */}
      {/* RENAME RESUME MODAL                                                 */}
      {/* =================================================================== */}
      {isRenameModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/60 backdrop-blur-xs animate-fadeIn"
        >
          <div className="bg-white rounded-[20px] ring-1 ring-[#E2E8F0] p-6 max-w-md w-full shadow-[0_16px_48px_rgba(15,23,42,0.18)] space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
              <h3 id="rename-modal-title" className="text-[16px] font-bold text-[#0F172A]">
                Rename Resume
              </h3>
              <button
                type="button"
                onClick={() => setIsRenameModalOpen(false)}
                aria-label="Close rename dialog"
                className="text-[#475569] hover:text-[#0F172A] p-1 rounded-full cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="resume-rename-input" className="text-[13px] font-semibold text-[#0F172A]">
                Resume Name
              </label>
              <input
                id="resume-rename-input"
                type="text"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                placeholder="e.g. Senior Software Engineer"
                className="w-full text-[14px] px-4 py-2.5 min-h-[44px] rounded-full border border-[#CBD5E1] bg-[#F1F5F9] focus:bg-white text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD] transition-colors"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setIsRenameModalOpen(false)}
                className="px-4 py-2 rounded-full bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] text-[13px] font-semibold min-h-[44px] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveRename}
                className="px-5 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[13px] font-bold min-h-[44px] cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* UPLOAD & CONFIRM MODAL                                              */}
      {/* =================================================================== */}
      {isUploadModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/60 backdrop-blur-xs overflow-y-auto animate-fadeIn"
        >
          <div className="bg-white rounded-[20px] ring-1 ring-[#E2E8F0] p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-[0_16px_48px_rgba(15,23,42,0.18)] space-y-4 my-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center text-[#2563EB]">
                  <UploadCloud className="w-4 h-4" />
                </div>
                <div>
                  <h3 id="upload-modal-title" className="text-[16px] font-bold text-[#0F172A]">
                    Upload & Confirm Resume Facts
                  </h3>
                  <p className="text-[12px] text-[#475569]">
                    Extract and confirm your background facts without invented achievements.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsUploadModalOpen(false)}
                aria-label="Close upload dialog"
                className="text-[#475569] hover:text-[#0F172A] p-1.5 rounded-full hover:bg-[#F1F5F9] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="pt-2">
              <ResumeUploadAndConfirm onProfileConfirmed={handleProfileConfirmed} />
            </div>
          </div>
        </div>
      )}
    </LoggedInAppShell>
  );
}
