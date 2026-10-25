"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import type { User } from "@supabase/supabase-js";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProfileDrawers, { ProfileSection } from "@/components/profile/ProfileDrawers";
import { getCandidateProfile, saveConfirmedCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import {
  User as UserIcon,
  Pencil,
  Plus,
  Mail,
  Phone,
  MapPin,
  Briefcase,
  GraduationCap,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  FileText,
  CheckSquare,
  Settings,
} from "lucide-react";

function ProfileSkeleton() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 md:py-8 space-y-6 w-full">
        <div className="h-8 w-48 bg-slate-200/80 rounded-lg animate-pulse" />
        <div className="h-32 w-full bg-white rounded-xl border border-slate-200 animate-pulse" />
        <div className="h-64 w-full bg-white rounded-xl border border-slate-200 animate-pulse" />
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(true);

  // Active section tab & scroll spy state
  const [activeTab, setActiveTab] = useState<ProfileSection>("personal");
  const isSmoothScrollingRef = useRef(false);
  const scrollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Drawer state
  const [activeDrawer, setActiveDrawer] = useState<ProfileSection | null>(null);
  const [openerElement, setOpenerElement] = useState<HTMLElement | null>(null);

  // Load user session and candidate profile
  const loadProfileData = useCallback(async (userId?: string) => {
    try {
      const [proRes, cp] = await Promise.all([
        getProAccessStatus(userId),
        getCandidateProfile(userId),
      ]);
      setIsPro(Boolean(proRes.isPro));
      if (cp && cp.confirmedAt) {
        setCandidate(cp);
      } else {
        setCandidate(cp || null);
      }
    } catch (err) {
      console.warn("Failed to load candidate profile:", err);
      setCandidate(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        // Fallback for local testing / offline verification when candidate profile is primed in storage
        if (typeof window !== "undefined") {
          try {
            const localUser = localStorage.getItem("careermonke_auth_user");
            const localProf = localStorage.getItem("careermonke_candidate_profile");
            if (localUser && localProf) {
              const parsedUser = JSON.parse(localUser);
              setUser(parsedUser);
              loadProfileData(parsedUser.id);
              return;
            }
          } catch {}
        }
        const returnUrl =
          typeof window !== "undefined"
            ? `${window.location.pathname}${window.location.search}`
            : "/profile";
        router.replace(`/login?next=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUser(u);
      loadProfileData(u.id);
    });

    const handleProfileUpdate = () => {
      getAuthUser().then((u) => {
        if (u) {
          setUser(u);
          loadProfileData(u.id);
        } else if (typeof window !== "undefined") {
          try {
            const localUser = localStorage.getItem("careermonke_auth_user");
            if (localUser) {
              const parsedUser = JSON.parse(localUser);
              setUser(parsedUser);
              loadProfileData(parsedUser.id);
            }
          } catch {}
        }
      });
    };

    window.addEventListener("careermonke_profile_updated", handleProfileUpdate);
    return () => {
      window.removeEventListener("careermonke_profile_updated", handleProfileUpdate);
    };
  }, [router, loadProfileData]);

  // Click-to-scroll with flicker prevention during transit
  const handleTabClick = (section: ProfileSection) => {
    setActiveTab(section);
    isSmoothScrollingRef.current = true;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);

    const el = document.getElementById(`section-${section}`);
    if (el) {
      // Offset accounting for sticky top bar (56px) + sticky tab header (~52px)
      const yOffset = -120;
      const y = el.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }

    scrollTimerRef.current = setTimeout(() => {
      isSmoothScrollingRef.current = false;
    }, 800);
  };

  // Scroll spy: updates activeTab as user scrolls through sections
  useEffect(() => {
    const handleScroll = () => {
      if (isSmoothScrollingRef.current) return;

      const sections: ProfileSection[] = ["personal", "education", "experience", "skills"];
      const offset = 140; // Detection trigger offset near top
      let currentSection: ProfileSection = "personal";

      for (const sectionId of sections) {
        const el = document.getElementById(`section-${sectionId}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= offset) {
            currentSection = sectionId;
          }
        }
      }

      setActiveTab((prev) => (prev === currentSection ? prev : currentSection));
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  // Drawer open handler (captures opener button for accessibility focus return)
  const handleOpenDrawer = (section: ProfileSection, e?: React.MouseEvent<HTMLElement>) => {
    if (e && e.currentTarget) {
      setOpenerElement(e.currentTarget);
    } else {
      setOpenerElement(null);
    }
    setActiveDrawer(section);
  };

  const handleCloseDrawer = () => {
    setActiveDrawer(null);
  };

  // Profile save action
  const handleSaveProfile = async (updated: CandidateProfile) => {
    if (typeof window !== "undefined" && (window as any).__MOCK_PROFILE_SAVE_ERROR__) {
      throw new Error((window as any).__MOCK_PROFILE_SAVE_ERROR__);
    }
    await saveConfirmedCandidateProfile(updated);
    setCandidate(updated);
    toast.success("Profile saved successfully.");
  };

  // Compute real profile completion statistics
  const hasPersonal = Boolean(
    candidate?.name?.trim() &&
      (candidate?.headline?.trim() || candidate?.summary?.trim() || candidate?.email?.trim())
  );
  const hasExperience = Boolean(candidate?.experience && candidate.experience.length > 0);
  const hasEducation = Boolean(candidate?.education && candidate.education.length > 0);
  const hasSkills = Boolean(candidate?.skills && candidate.skills.length >= 3);

  const completionChecks = [
    { id: "personal" as ProfileSection, label: "Personal details & headline", done: hasPersonal },
    { id: "education" as ProfileSection, label: "Education & degrees", done: hasEducation },
    { id: "experience" as ProfileSection, label: "Work experience", done: hasExperience },
    { id: "skills" as ProfileSection, label: "Core skills (3+ required)", done: hasSkills },
  ];

  const completedCount = completionChecks.filter((c) => c.done).length;
  const completionPercentage = Math.round((completedCount / completionChecks.length) * 100);

  // Derived user display name
  const displayName =
    candidate?.name ||
    (user?.user_metadata?.full_name as string) ||
    (user?.user_metadata?.name as string) ||
    (user?.email ? user.email.split("@")[0] : "Candidate");

  const initial = displayName.charAt(0).toUpperCase();

  if (loading || !user) {
    return <ProfileSkeleton />;
  }

  return (
    <LoggedInAppShell
      pageLabel="PROFILE"
      user={user}
      isPro={isPro}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 md:py-8 space-y-6">
        {/* ================================================================= */}
        {/* 1. STICKY SECTION TABS WITH SCROLL-SPY                            */}
        {/* ================================================================= */}
        <div className="sticky top-14 z-20 bg-[#F8FAFC]/95 backdrop-blur-xs pt-1 border-b border-[#E2E8F0]">
          <nav
            role="tablist"
            aria-label="Profile Sections"
            data-testid="profile-section-tabs"
            className="flex items-center gap-2 sm:gap-4 overflow-x-auto no-scrollbar"
          >
            {(
              [
                { id: "personal", label: "Personal" },
                { id: "education", label: "Education" },
                { id: "experience", label: "Work Experience" },
                { id: "skills", label: "Skills" },
              ] as const
            ).map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`section-${tab.id}`}
                  onClick={() => handleTabClick(tab.id)}
                  data-testid={`profile-tab-${tab.id}`}
                  data-active={isActive ? "true" : "false"}
                  className={`relative h-12 min-h-[44px] px-3 sm:px-4 text-[14px] transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? "font-bold text-[#0F172A] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-[#0F172A]"
                      : "font-medium text-[#64748B] hover:text-[#0F172A]"
                  }`}
                >
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* ================================================================= */}
        {/* 2. MAIN 2-COLUMN LAYOUT (DESKTOP) / 1-COLUMN (MOBILE)             */}
        {/* ================================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* =============================================================== */}
          {/* LEFT / CENTER COLUMN: Profile Cards (col-span-8)                 */}
          {/* =============================================================== */}
          <div className="lg:col-span-8 space-y-6">
            {/* ------------------------------------------------------------- */}
            {/* HEADER CARD                                                   */}
            {/* ------------------------------------------------------------- */}
            <section
              aria-label="Profile Header"
              data-testid="profile-header-card"
              className="bg-white rounded-2xl border border-[#E2E8F0] p-6 relative shadow-none"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start sm:items-center gap-4">
                  {/* Avatar circle */}
                  <div className="w-16 h-16 rounded-full bg-[#2563EB] text-white font-bold text-2xl flex items-center justify-center shrink-0 select-none shadow-xs">
                    {initial}
                  </div>

                  <div className="space-y-1 min-w-0">
                    <h2 className="text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight truncate">
                      {displayName}
                    </h2>
                    {candidate?.headline && (
                      <p className="text-sm font-medium text-[#475569] leading-snug">
                        {candidate.headline}
                      </p>
                    )}
                  </div>
                </div>

                {/* Edit Pencil Button */}
                <button
                  type="button"
                  onClick={(e) => handleOpenDrawer("personal", e)}
                  aria-label="Edit personal details"
                  data-testid="edit-header-btn"
                  className="self-start sm:self-center w-11 h-11 min-h-[44px] min-w-[44px] rounded-xl border border-[#E2E8F0] hover:border-[#93C5FD] hover:bg-[#F8FAFC] text-[#475569] hover:text-[#2563EB] flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>

              {/* Contact Chips ONLY for actual stored non-empty values */}
              {(candidate?.email || candidate?.phone || candidate?.location) && (
                <div className="mt-5 pt-4 border-t border-[#E2E8F0] flex flex-wrap gap-2.5">
                  {candidate.email && (
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F1F5F9] text-[#475569] text-xs font-medium">
                      <Mail className="w-3.5 h-3.5 text-[#64748B]" />
                      <span className="truncate max-w-[220px]">{candidate.email}</span>
                    </div>
                  )}
                  {candidate.phone && (
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F1F5F9] text-[#475569] text-xs font-medium">
                      <Phone className="w-3.5 h-3.5 text-[#64748B]" />
                      <span>{candidate.phone}</span>
                    </div>
                  )}
                  {candidate.location && (
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F1F5F9] text-[#475569] text-xs font-medium">
                      <MapPin className="w-3.5 h-3.5 text-[#64748B]" />
                      <span>{candidate.location}</span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* ------------------------------------------------------------- */}
            {/* SECTION: PERSONAL (SUMMARY)                                   */}
            {/* ------------------------------------------------------------- */}
            <section
              id="section-personal"
              aria-label="Personal Information"
              data-testid="profile-section-personal"
              className="bg-white rounded-2xl border border-[#E2E8F0] p-6 space-y-4 shadow-none scroll-mt-32"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserIcon className="w-5 h-5 text-[#2563EB]" />
                  <h3 className="text-[16px] font-bold text-[#0F172A]">About & Summary</h3>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleOpenDrawer("personal", e)}
                  aria-label="Edit summary"
                  className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-xl hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#2563EB] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>

              {candidate?.summary?.trim() ? (
                <p className="text-[14px] text-[#475569] leading-relaxed whitespace-pre-line">
                  {candidate.summary}
                </p>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-xs text-[#64748B]">No professional summary provided yet.</p>
                  <button
                    type="button"
                    onClick={(e) => handleOpenDrawer("personal", e)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] cursor-pointer min-h-[44px]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add summary</span>
                  </button>
                </div>
              )}
            </section>

            {/* ------------------------------------------------------------- */}
            {/* SECTION: EDUCATION (Timeline track #BFDBFE, dots #2563EB)     */}
            {/* ------------------------------------------------------------- */}
            <section
              id="section-education"
              aria-label="Education"
              data-testid="profile-section-education"
              className="bg-white rounded-2xl border border-[#E2E8F0] p-6 space-y-4 shadow-none scroll-mt-32"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-5 h-5 text-[#2563EB]" />
                  <h3 className="text-[16px] font-bold text-[#0F172A]">
                    Education
                    {candidate?.education?.length ? ` (${candidate.education.length})` : ""}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleOpenDrawer("education", e)}
                  aria-label="Edit education"
                  className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-xl hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#2563EB] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>

              {candidate?.education && candidate.education.length > 0 ? (
                <div className="relative pl-6 space-y-5 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-[2px] before:bg-[#BFDBFE]">
                  {candidate.education.map((edu, idx) => (
                    <div key={edu.id || `edu-${idx}`} className="relative space-y-1">
                      {/* Timeline dot #2563EB */}
                      <span className="absolute -left-[27px] top-1.5 w-3 h-3 rounded-full bg-[#2563EB] border-2 border-white ring-2 ring-[#EFF6FF]" />

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                        <h4 className="text-[15px] font-bold text-[#0F172A]">
                          {edu.degree || "Degree"}
                        </h4>
                        {edu.year && (
                          <span className="text-xs text-[#64748B] font-medium">{edu.year}</span>
                        )}
                      </div>

                      <p className="text-[13px] text-[#475569] font-medium">
                        {edu.institution}
                        {edu.fieldOfStudy ? ` • ${edu.fieldOfStudy}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-xs text-[#64748B]">No education listed yet.</p>
                  <button
                    type="button"
                    onClick={(e) => handleOpenDrawer("education", e)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] cursor-pointer min-h-[44px]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add education</span>
                  </button>
                </div>
              )}
            </section>

            {/* ------------------------------------------------------------- */}
            {/* SECTION: WORK EXPERIENCE (Timeline track #BFDBFE, dots #2563EB) */}
            {/* ------------------------------------------------------------- */}
            <section
              id="section-experience"
              aria-label="Work Experience"
              data-testid="profile-section-experience"
              className="bg-white rounded-2xl border border-[#E2E8F0] p-6 space-y-4 shadow-none scroll-mt-32"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-[#2563EB]" />
                  <h3 className="text-[16px] font-bold text-[#0F172A]">
                    Work Experience
                    {candidate?.experience?.length ? ` (${candidate.experience.length})` : ""}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleOpenDrawer("experience", e)}
                  aria-label="Edit work experience"
                  className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-xl hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#2563EB] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>

              {candidate?.experience && candidate.experience.length > 0 ? (
                <div className="relative pl-6 space-y-6 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-[2px] before:bg-[#BFDBFE]">
                  {candidate.experience.map((exp, idx) => (
                    <div key={exp.id || `exp-${idx}`} className="relative space-y-1.5">
                      {/* Timeline dot #2563EB */}
                      <span className="absolute -left-[27px] top-1.5 w-3 h-3 rounded-full bg-[#2563EB] border-2 border-white ring-2 ring-[#EFF6FF]" />

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                        <h4 className="text-[15px] font-bold text-[#0F172A]">
                          {exp.role || "Role"}
                        </h4>
                        <span className="text-xs text-[#64748B] font-medium">
                          {exp.startDate || ""} {exp.startDate && exp.endDate ? "—" : ""}{" "}
                          {exp.endDate || ""}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-[13px] text-[#475569] font-medium">
                        <span>{exp.company}</span>
                        {exp.location && (
                          <>
                            <span className="text-[#CBD5E1]">•</span>
                            <span className="text-xs text-[#64748B]">{exp.location}</span>
                          </>
                        )}
                      </div>

                      {Array.isArray(exp.bullets) && exp.bullets.length > 0 && (
                        <ul className="list-disc list-inside space-y-1 pt-1.5 text-xs text-[#475569] leading-relaxed">
                          {exp.bullets.map((bullet, bIdx) => (
                            <li key={bIdx} className="leading-normal">
                              {bullet}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-xs text-[#64748B]">No work experience listed yet.</p>
                  <button
                    type="button"
                    onClick={(e) => handleOpenDrawer("experience", e)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] cursor-pointer min-h-[44px]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add work experience</span>
                  </button>
                </div>
              )}
            </section>

            {/* ------------------------------------------------------------- */}
            {/* SECTION: SKILLS                                               */}
            {/* ------------------------------------------------------------- */}
            <section
              id="section-skills"
              aria-label="Skills"
              data-testid="profile-section-skills"
              className="bg-white rounded-2xl border border-[#E2E8F0] p-6 space-y-4 shadow-none scroll-mt-32"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-[#2563EB]" />
                  <h3 className="text-[16px] font-bold text-[#0F172A]">
                    Skills{candidate?.skills?.length ? ` (${candidate.skills.length})` : ""}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleOpenDrawer("skills", e)}
                  aria-label="Edit skills"
                  className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-xl hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#2563EB] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>

              {candidate?.skills && candidate.skills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {candidate.skills.map((skill) => (
                    <span
                      key={skill}
                      className="bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE] text-xs font-medium px-3 py-1.5 rounded-full"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-xs text-[#64748B]">No skills added yet.</p>
                  <button
                    type="button"
                    onClick={(e) => handleOpenDrawer("skills", e)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] cursor-pointer min-h-[44px]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add skills</span>
                  </button>
                </div>
              )}
            </section>
          </div>

          {/* =============================================================== */}
          {/* RIGHT RAIL: Profile Strength & Quick Links (col-span-4)         */}
          {/* =============================================================== */}
          <aside
            aria-label="Profile Sidebar"
            data-testid="profile-right-rail"
            className="lg:col-span-4 space-y-6"
          >
            {/* Card 1: Profile Completion Warning & Actions */}
            <div className="bg-white rounded-2xl border border-[#E2E8F0] p-5 sm:p-6 space-y-4 shadow-none">
              <div className="flex items-center justify-between">
                <h4 className="text-[15px] font-bold text-[#0F172A]">Profile Strength</h4>
                <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-[#EFF6FF] text-[#2563EB]">
                  {completionPercentage}%
                </span>
              </div>

              {/* Progress track */}
              <div className="w-full h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    completionPercentage === 100 ? "bg-[#16A34A]" : "bg-[#2563EB]"
                  }`}
                  style={{ width: `${completionPercentage}%` }}
                />
              </div>

              {/* Checklist & Missing Items Warning */}
              {completionPercentage < 100 ? (
                <div className="space-y-3 pt-1">
                  <div className="flex items-start gap-2 text-xs text-[#92400E] bg-[#FEF3C7] p-2.5 rounded-xl border border-[#FDE68A]">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#92400E]" />
                    <span>
                      Complete your profile to improve job matching accuracy and tailor applications.
                    </span>
                  </div>

                  <ul className="space-y-2">
                    {completionChecks.map((item) => (
                      <li key={item.id} className="flex items-center justify-between text-xs py-1">
                        <div className="flex items-center gap-2">
                          <CheckCircle2
                            className={`w-4 h-4 ${
                              item.done ? "text-[#166534]" : "text-[#CBD5E1]"
                            }`}
                          />
                          <span
                            className={
                              item.done ? "text-[#475569]" : "text-[#0F172A] font-medium"
                            }
                          >
                            {item.label}
                          </span>
                        </div>
                        {!item.done && (
                          <button
                            type="button"
                            onClick={(e) => handleOpenDrawer(item.id, e)}
                            className="text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] hover:underline cursor-pointer min-h-[44px] flex items-center"
                          >
                            Add
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-[#166534] bg-[#DCFCE7] p-3 rounded-xl border border-[#BBF7D0]">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="font-medium">All core profile sections are completed.</span>
                </div>
              )}
            </div>

            {/* Card 2: Quick Links (Strictly to existing internal pages) */}
            <div className="bg-white rounded-2xl border border-[#E2E8F0] p-5 sm:p-6 space-y-3 shadow-none">
              <h4 className="text-[15px] font-bold text-[#0F172A] mb-1">Quick Links</h4>
              <nav aria-label="Profile Quick Links" className="space-y-1">
                <Link
                  href="/resume"
                  className="flex items-center justify-between p-2.5 rounded-xl hover:bg-[#F8FAFC] text-[#475569] hover:text-[#0F172A] transition-colors group min-h-[44px]"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 text-[#2563EB]" />
                    <span className="text-xs font-medium">Manage Resumes</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#64748B] group-hover:text-[#0F172A] group-hover:translate-x-0.5 transition-all" />
                </Link>

                <Link
                  href="/tracker"
                  className="flex items-center justify-between p-2.5 rounded-xl hover:bg-[#F8FAFC] text-[#475569] hover:text-[#0F172A] transition-colors group min-h-[44px]"
                >
                  <div className="flex items-center gap-3">
                    <CheckSquare className="w-4 h-4 text-[#2563EB]" />
                    <span className="text-xs font-medium">Application Tracker</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#64748B] group-hover:text-[#0F172A] group-hover:translate-x-0.5 transition-all" />
                </Link>

                <Link
                  href="/jobs"
                  className="flex items-center justify-between p-2.5 rounded-xl hover:bg-[#F8FAFC] text-[#475569] hover:text-[#0F172A] transition-colors group min-h-[44px]"
                >
                  <div className="flex items-center gap-3">
                    <Briefcase className="w-4 h-4 text-[#2563EB]" />
                    <span className="text-xs font-medium">Explore Jobs</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#64748B] group-hover:text-[#0F172A] group-hover:translate-x-0.5 transition-all" />
                </Link>

                <Link
                  href="/settings"
                  className="flex items-center justify-between p-2.5 rounded-xl hover:bg-[#F8FAFC] text-[#475569] hover:text-[#0F172A] transition-colors group min-h-[44px]"
                >
                  <div className="flex items-center gap-3">
                    <Settings className="w-4 h-4 text-[#2563EB]" />
                    <span className="text-xs font-medium">Account Settings</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#64748B] group-hover:text-[#0F172A] group-hover:translate-x-0.5 transition-all" />
                </Link>
              </nav>
            </div>
          </aside>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 3. PROFILE EDIT DRAWERS (Right Slide-Over)                          */}
      {/* =================================================================== */}
      <ProfileDrawers
        isOpen={Boolean(activeDrawer)}
        section={activeDrawer}
        candidate={candidate}
        openerElement={openerElement}
        onClose={handleCloseDrawer}
        onSave={handleSaveProfile}
      />

          </LoggedInAppShell>
  );
}
