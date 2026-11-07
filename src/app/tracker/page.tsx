"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LayoutGrid,
  List,
  Plus,
  Search,
  Building,
  Calendar,
  ExternalLink,
  Trash2,
  FileText,
  Clock,
  AlertCircle,
  X,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import AppIconRail from "@/components/shell/AppIconRail";
import AppTopBar from "@/components/shell/AppTopBar";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import CompanyLogo from "@/components/CompanyLogo";
import {
  TrackedApplication,
  ApplicationStage,
  KANBAN_STAGES,
} from "@/lib/tracker/types";
import {
  getTrackedApplications,
  updateApplicationStage,
  updateApplicationNotes,
  deleteApplicationFromTracker,
  addApplicationToTracker,
} from "@/lib/tracker/storage";
import { getTodayDigest, DigestMatchItem } from "@/lib/cron/digestStorage";
import { toast } from "react-toastify";
import MatchScoreBadge from "@/components/matcher/MatchScoreBadge";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import { sanitizeExternalUrl } from "@/lib/security/xss";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import type { User } from "@supabase/supabase-js";

export default function TrackerPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [applications, setApplications] = useState<TrackedApplication[]>([]);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [searchQuery, setSearchQuery] = useState("");
  const [digest, setDigest] = useState<{
    digestDate: string;
    matches: DigestMatchItem[];
    isQueuedByCron: boolean;
  } | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const [isScanningDigest, setIsScanningDigest] = useState(false);
  const [draggedAppId, setDraggedAppId] = useState<string | null>(null);
  const [dropTargetStage, setDropTargetStage] = useState<ApplicationStage | null>(null);

  // Modal States
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [activeNotesApp, setActiveNotesApp] = useState<TrackedApplication | null>(null);
  const [notesDraft, setNotesDraft] = useState("");

  // New Application Form State with Inline Validation
  const [newTitle, setNewTitle] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newSalary, setNewSalary] = useState("");
  const [newApplyUrl, setNewApplyUrl] = useState("");
  const [newStage, setNewStage] = useState<ApplicationStage>("saved");
  const [newNotes, setNewNotes] = useState("");
  const [formErrors, setFormErrors] = useState<{ title?: string; company?: string }>({});

  const loadData = async (userId?: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [proRes, apps, todayDigest] = await Promise.all([
        getProAccessStatus(userId),
        getTrackedApplications(userId),
        getTodayDigest(userId),
      ]);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      setApplications(apps);
      setDigest(todayDigest);
    } catch (err: any) {
      setLoadError(err?.message || "Failed to load tracked applications.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?returnTo=/tracker");
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
    window.addEventListener("careermonke_tracker_updated", handleUpdate);
    return () => window.removeEventListener("careermonke_tracker_updated", handleUpdate);
  }, [router]);

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("text/plain", id);
    setDraggedAppId(id);
  };

  const handleDragOver = (e: React.DragEvent, stage: ApplicationStage) => {
    e.preventDefault();
    if (dropTargetStage !== stage) {
      setDropTargetStage(stage);
    }
  };

  const handleDragLeave = (stage: ApplicationStage) => {
    if (dropTargetStage === stage) {
      setDropTargetStage(null);
    }
  };

  const handleDrop = async (e: React.DragEvent, targetStage: ApplicationStage) => {
    e.preventDefault();
    setDropTargetStage(null);
    const appId = e.dataTransfer.getData("text/plain") || draggedAppId;
    setDraggedAppId(null);
    if (!appId) return;

    const app = applications.find((a) => a.id === appId);
    if (!app || app.stage === targetStage) return;

    // Optimistic Update
    setApplications((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, stage: targetStage, updatedAt: new Date().toISOString() } : a))
    );

    try {
      await updateApplicationStage(appId, targetStage);
      toast.success(`Moved to ${targetStage}`);
    } catch {
      toast.error("Failed to update stage. Reverting...");
      loadData(user?.id);
    }
  };

  const handleStageSelect = async (appId: string, stage: ApplicationStage) => {
    setApplications((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, stage, updatedAt: new Date().toISOString() } : a))
    );
    try {
      await updateApplicationStage(appId, stage);
      toast.success(`Moved to ${stage}`);
    } catch {
      toast.error("Failed to update stage.");
      loadData(user?.id);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Remove this application from tracker?")) return;
    setApplications((prev) => prev.filter((a) => a.id !== id));
    try {
      await deleteApplicationFromTracker(id);
      toast.info("Application removed");
    } catch {
      toast.error("Failed to delete application.");
      loadData(user?.id);
    }
  };

  const handleOpenNotes = (app: TrackedApplication) => {
    setActiveNotesApp(app);
    setNotesDraft(app.notes || "");
  };

  const handleSaveNotes = async () => {
    if (!activeNotesApp) return;
    const appId = activeNotesApp.id;
    const newNotesVal = notesDraft.trim();

    setApplications((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, notes: newNotesVal, updatedAt: new Date().toISOString() } : a))
    );
    setActiveNotesApp(null);

    try {
      await updateApplicationNotes(appId, newNotesVal);
      toast.success("Notes saved");
    } catch {
      toast.error("Failed to save notes.");
      loadData(user?.id);
    }
  };

  const handleCreateApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { title?: string; company?: string } = {};
    if (!newTitle.trim()) errors.title = "Job title is required.";
    if (!newCompany.trim()) errors.company = "Company name is required.";

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    try {
      const added = await addApplicationToTracker({
        title: newTitle.trim(),
        company: newCompany.trim(),
        location: newLocation.trim() || undefined,
        salaryText: newSalary.trim() || undefined,
        applyUrl: newApplyUrl.trim() || undefined,
        stage: newStage,
        notes: newNotes.trim() || undefined,
      });

      setApplications((prev) => [added, ...prev]);
      setIsAddModalOpen(false);
      setNewTitle("");
      setNewCompany("");
      setNewLocation("");
      setNewSalary("");
      setNewApplyUrl("");
      setNewNotes("");
      setNewStage("saved");
      setFormErrors({});
      toast.success("Application tracked!");
    } catch {
      toast.error("Failed to add application.");
    }
  };

  const handleAddDigestToPipeline = async (item: DigestMatchItem) => {
    try {
      const added = await addApplicationToTracker({
        jobId: item.jobId,
        title: item.title,
        company: item.company,
        location: item.location,
        applyUrl: item.applyUrl,
        stage: "saved",
        notes: `AI Match (${item.score}%): Evidenced skills: ${item.matchedSkills.join(", ")}`,
      });
      setApplications((prev) => [added, ...prev]);
      toast.success(`Added "${item.title}" to Saved!`);
    } catch {
      toast.error("Failed to add digest role.");
    }
  };

  const handleRefreshScan = async () => {
    setIsScanningDigest(true);
    try {
      const res = await fetch("/api/ai?action=digest_scan", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.matches) {
          setDigest({
            digestDate: new Date().toISOString().split("T")[0],
            matches: data.matches,
            isQueuedByCron: false,
          });
          setShowDigest(true);
          toast.success("AI pipeline scan complete!");
        }
      } else {
        toast.info("Pipeline up to date.");
      }
    } catch {
      toast.info("Automated daily scan is running in background.");
    } finally {
      setIsScanningDigest(false);
    }
  };

  const filteredApps = applications.filter((app) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      app.title.toLowerCase().includes(q) ||
      app.company.toLowerCase().includes(q) ||
      (app.location && app.location.toLowerCase().includes(q)) ||
      (app.notes && app.notes.toLowerCase().includes(q))
    );
  });

  const stageCounts = {
    saved: applications.filter((a) => a.stage === "saved").length,
    applied: applications.filter((a) => a.stage === "applied").length,
    interview: applications.filter((a) => a.stage === "interview").length,
    offer: applications.filter((a) => a.stage === "offer").length,
    rejected: applications.filter((a) => a.stage === "rejected").length,
  };

  if (isLoading || (!isPro && !isProDefinitive)) {
    return (
      <LoggedInAppShell pageLabel="TRACKER" user={user} isPro={isPro}>
        <div className="max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          <div className="h-8 w-64 bg-[#E2E8F0] animate-pulse rounded-full" />
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="min-h-[420px] p-3 rounded-[16px] bg-[#F1F5F9] border border-[#E2E8F0] space-y-3">
                <div className="h-5 w-24 bg-[#E2E8F0] rounded-full animate-pulse" />
                <div className="h-28 w-full bg-white rounded-[12px] ring-1 ring-[#E2E8F0] animate-pulse" />
                <div className="h-28 w-full bg-white rounded-[12px] ring-1 ring-[#E2E8F0] animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </LoggedInAppShell>
    );
  }

  // Definitively non-Pro
  if (!isPro) {
    return (
      <LoggedInAppShell pageLabel="TRACKER" user={user} isPro={false}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
          <ProUpgradeScreen
            title="Unlock Application Tracker"
            subtitle="Upgrade to CareerMonke Pro to save jobs, track interview stages, and manage your pipeline."
          />
        </div>
              </LoggedInAppShell>
    );
  }

  return (
    <LoggedInAppShell
      pageLabel="TRACKER"
      user={user}
      isPro={isPro}
      mainClassName="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-4 space-y-5 sm:space-y-3.5 pb-24 lg:pb-12"
    >
          {/* Top row above the board: segmented control, search input pill, primary blue Add button */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
            {/* Segmented control for views (Board / List) */}
            <div className="inline-flex items-center p-1 rounded-full bg-[#F1F5F9] border border-[#E2E8F0] shrink-0 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setViewMode("kanban")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[12px] font-bold transition-all min-h-[36px] cursor-pointer ${
                  viewMode === "kanban"
                    ? "bg-white text-[#0F172A] shadow-sm ring-1 ring-[#E2E8F0]"
                    : "text-[#475569] hover:text-[#0F172A]"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Board</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[12px] font-bold transition-all min-h-[36px] cursor-pointer ${
                  viewMode === "list"
                    ? "bg-white text-[#0F172A] shadow-sm ring-1 ring-[#E2E8F0]"
                    : "text-[#475569] hover:text-[#0F172A]"
                }`}
              >
                <List className="w-3.5 h-3.5" />
                <span>List</span>
              </button>
            </div>

            {/* Middle & Right: Search input pill like top bar & Primary blue Add button */}
            <div className="flex flex-1 sm:justify-end items-center gap-2.5">
              <div className="relative flex-1 max-w-sm">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#94A3B8]" />
                <input
                  type="text"
                  aria-label="Search by company, role, or notes"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by title or company..."
                  className="w-full text-[13px] pl-9 pr-8 py-2 min-h-[40px] rounded-full border border-[#E2E8F0] bg-[#F1F5F9] focus:bg-white text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#93C5FD] transition-colors"
                />
                {searchQuery && (
                  <button
                    aria-label="Clear search"
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#0F172A] text-xs"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setIsAddModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-5 py-2 min-h-[40px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[13px] font-bold shadow-none transition focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add application</span>
              </button>
            </div>
          </div>

          {/* Daily Automated Digest Banner */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 sm:p-4 shadow-none space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[12px] bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB] flex items-center justify-center shrink-0">
                  <Sparkles className="w-5 h-5 text-[#2563EB]" />
                </div>
                <div>
                  <h3 className="text-[14px] sm:text-[15px] font-bold text-[#0F172A] flex items-center gap-2">
                    <span>Daily AI Matching Digest</span>
                    {digest && digest.matches.length > 0 && (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                        {digest.matches.length} Top Roles
                      </span>
                    )}
                  </h3>
                  <p className="text-[12px] text-[#475569]">
                    {digest?.isQueuedByCron
                      ? "Queued by Daily Automated Cron scan against confirmed profile skills."
                      : "Automated scan evaluates verified tech listings against your confirmed resume."}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <button
                  type="button"
                  onClick={handleRefreshScan}
                  disabled={isScanningDigest}
                  className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[12px] font-bold transition shadow-none cursor-pointer disabled:opacity-60"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isScanningDigest ? "animate-spin" : ""}`} />
                  <span>{isScanningDigest ? "Scanning..." : "Run AI Scan"}</span>
                </button>

                {digest && digest.matches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowDigest(!showDigest)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-full bg-[#F1F5F9] border border-[#E2E8F0] text-[#0F172A] hover:bg-[#E2E8F0] text-[12px] font-semibold transition cursor-pointer"
                  >
                    <span>{showDigest ? "Hide Digest" : "Show Digest"}</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDigest ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            </div>

            {showDigest && digest && digest.matches.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3 border-t border-[#E2E8F0] animate-fadeIn">
                {digest.matches.map((item) => (
                  <div
                    key={item.jobId}
                    className="bg-[#F8FAFC] rounded-[12px] p-3.5 border border-[#E2E8F0] space-y-2 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="font-bold text-[13px] text-[#0F172A] line-clamp-1">{item.title}</span>
                        <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[#DCFCE7] text-[#166534] shrink-0">
                          {item.score}% Match
                        </span>
                      </div>
                      <div className="text-[12px] text-[#475569] font-medium">{item.company} • {item.location}</div>
                      {item.matchedSkills.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {item.matchedSkills.slice(0, 3).map((s) => (
                            <span key={s} className="text-[11px] bg-white text-[#475569] px-2 py-0.5 rounded-full border border-[#E2E8F0]">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="pt-2 border-t border-[#E2E8F0] flex items-center justify-between gap-2 min-h-[36px]">
                      <button
                        type="button"
                        onClick={() => handleAddDigestToPipeline(item)}
                        className="text-[12px] font-bold text-[#2563EB] hover:text-[#1D4ED8] flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add to Saved</span>
                      </button>

                      {sanitizeExternalUrl(item.applyUrl) && (
                        <a
                          href={sanitizeExternalUrl(item.applyUrl)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12px] text-[#475569] hover:text-[#0F172A] flex items-center gap-0.5"
                        >
                          <span>Apply</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : showDigest ? (
              <div className="pt-3 pb-1 border-t border-[#E2E8F0] text-center">
                <p className="text-[12px] text-[#475569]">
                  No matching roles generated yet for today. Click <strong className="text-[#0F172A]">&quot;Run AI Scan&quot;</strong> above to scan unindexed listings against your resume!
                </p>
              </div>
            ) : null}
          </div>

          {/* Error State with Retry */}
          {loadError ? (
            <div className="bg-white border border-[#FEE2E2] rounded-[16px] p-8 sm:p-12 text-center space-y-4 max-w-xl mx-auto shadow-none">
              <div className="w-12 h-12 rounded-full bg-[#FEE2E2] text-[#DC2626] mx-auto flex items-center justify-center">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-[#0F172A]">Unable to Load Tracker Pipeline</h3>
                <p className="text-xs sm:text-sm text-[#475569]">{loadError}</p>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => loadData(user?.id)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs transition cursor-pointer"
                >
                  <span>Retry Connection</span>
                </button>
              </div>
            </div>
          ) : viewMode === "kanban" ? (
            /* View Mode 1: KANBAN BOARD */
            /* Mobile: columns become a horizontal snap-scroll row */
            <div
              data-testid="tracker-board"
              className="flex overflow-x-auto snap-x snap-mandatory gap-3.5 pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4 sm:overflow-visible items-start"
            >
              {KANBAN_STAGES.map((col) => {
                const colApps = filteredApps.filter((a) => a.stage === col.id);
                const isDropTarget = dropTargetStage === col.id;

                return (
                  <div
                    key={col.id}
                    data-testid={`tracker-column-${col.id}`}
                    onDragOver={(e) => handleDragOver(e, col.id)}
                    onDragLeave={() => handleDragLeave(col.id)}
                    onDrop={(e) => handleDrop(e, col.id)}
                    className={`bg-[#F1F5F9] rounded-[16px] p-3 transition-colors min-h-[220px] sm:min-h-[260px] flex flex-col shrink-0 min-w-[280px] w-[82vw] max-w-[320px] snap-center sm:min-w-0 sm:w-auto sm:max-w-none ${
                      isDropTarget
                        ? "ring-2 ring-[#2563EB] bg-[#EFF6FF]"
                        : "border border-transparent"
                    }`}
                  >
                    {/* Column Header */}
                    <div className="flex items-center justify-between pb-2.5 px-1 border-b border-[#E2E8F0] mb-3">
                      <span className="text-[14px] font-bold text-[#0F172A]">
                        {col.label}
                      </span>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#0F172A] text-white">
                        {colApps.length}
                      </span>
                    </div>

                    {/* Cards List */}
                    <div className="space-y-3 flex-1 overflow-y-auto">
                      {colApps.length === 0 ? (
                        /* Empty column: dashed #CBD5E1 border, one muted line of existing wording */
                        <div className="h-32 border-2 border-dashed border-[#CBD5E1] rounded-[12px] flex items-center justify-center p-4 text-center">
                          <span className="text-[12px] text-[#64748B] font-medium">
                            Drop applications here
                          </span>
                        </div>
                      ) : (
                        colApps.map((app) => {
                          const isDragging = draggedAppId === app.id;
                          return (
                            <div
                              key={app.id}
                              data-testid="tracker-card"
                              draggable
                              onDragStart={(e) => handleDragStart(e, app.id)}
                              onDragEnd={() => setDraggedAppId(null)}
                              className={`bg-white rounded-[12px] p-3.5 space-y-2.5 group transition-all duration-200 select-none ${
                                isDragging
                                  ? "ring-2 ring-[#93C5FD] shadow-[0_8px_20px_rgba(15,23,42,0.12)] opacity-80 cursor-grabbing"
                                  : "ring-1 ring-[#E2E8F0] shadow-none hover:ring-[#93C5FD] cursor-grab"
                              }`}
                            >
                              {/* Header: 32px company logo, bold 14px title, 13px #475569 company */}
                              <div className="flex items-start gap-2.5">
                                <CompanyLogo
                                  company={app.company}
                                  applyUrl={app.applyUrl}
                                  className="w-8 h-8 rounded-lg shrink-0 object-contain p-0.5 border border-[#E2E8F0] bg-white"
                                />

                                <div className="min-w-0 flex-1 space-y-0.5">
                                  <div className="flex items-start justify-between gap-1.5">
                                    <h4 className="text-[14px] font-bold text-[#0F172A] leading-snug line-clamp-2">
                                      {app.title}
                                    </h4>
                                    <button
                                      type="button"
                                      onClick={() => handleDelete(app.id)}
                                      className="text-[#64748B] hover:text-[#DC2626] transition p-1 cursor-pointer shrink-0 min-h-[28px] min-w-[28px] flex items-center justify-center"
                                      title="Remove application"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>

                                  <div className="text-[13px] text-[#475569] truncate">
                                    {app.company}
                                  </div>
                                </div>
                              </div>

                              {/* Match Score Badge & Location/Salary Chips */}
                              <div className="flex flex-wrap items-center gap-1.5">
                                <MatchScoreBadge
                                  job={{
                                    id: app.id,
                                    title: app.title,
                                    company: app.company,
                                    location: app.location,
                                    salary_text: app.salaryText,
                                    apply_url: app.applyUrl,
                                  }}
                                  size="xs"
                                />
                                {app.location && (
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569] truncate max-w-[140px]">
                                    {app.location}
                                  </span>
                                )}
                                {app.salaryText && (
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#DCFCE7] text-[#166534] truncate max-w-[140px]">
                                    {app.salaryText}
                                  </span>
                                )}
                              </div>

                              {/* Applied/updated date 12px #64748B */}
                              <div className="text-[12px] text-[#64748B] flex items-center gap-1">
                                <Clock className="w-3 h-3 shrink-0" />
                                <span>
                                  {app.appliedAt
                                    ? `Applied ${new Date(app.appliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                                    : `Updated ${new Date(app.updatedAt || app.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                                </span>
                              </div>

                              {/* Notes UI: keep as is, restyled with same tokens */}
                              {app.notes && (
                                <div
                                  onClick={() => handleOpenNotes(app)}
                                  className="p-2 bg-[#F8FAFC] rounded-[8px] border border-[#E2E8F0] text-[12px] text-[#475569] line-clamp-2 cursor-pointer hover:bg-white hover:border-[#93C5FD] transition"
                                  title="Click to edit notes"
                                >
                                  <span className="font-semibold text-[#0F172A] mr-1">Note:</span>
                                  {app.notes}
                                </div>
                              )}

                              {/* Actions Bottom Bar */}
                              <div className="pt-2 border-t border-[#E2E8F0] flex items-center justify-between gap-2 min-h-[36px]">
                                <select
                                  value={app.stage}
                                  onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                                  className="text-[11px] font-medium py-1 px-2 rounded-full border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#93C5FD] cursor-pointer"
                                >
                                  {KANBAN_STAGES.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      Move: {s.label}
                                    </option>
                                  ))}
                                </select>

                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleOpenNotes(app)}
                                    className="p-1.5 text-[#94A3B8] hover:text-[#2563EB] transition cursor-pointer min-h-[32px] min-w-[32px] flex items-center justify-center rounded-full hover:bg-[#EFF6FF]"
                                    title="Add/Edit Notes"
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                  </button>

                                  {sanitizeExternalUrl(app.applyUrl) && (
                                    <a
                                      href={sanitizeExternalUrl(app.applyUrl)!}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1.5 text-[#94A3B8] hover:text-[#2563EB] transition min-h-[32px] min-w-[32px] flex items-center justify-center rounded-full hover:bg-[#EFF6FF]"
                                      title="Open Official Job Page"
                                    >
                                      <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* View Mode 2: LIST / TABLE VIEW */
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] overflow-hidden shadow-none">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#475569] font-semibold uppercase text-[11px] tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Company & Role</th>
                      <th className="py-3 px-4">Stage</th>
                      <th className="py-3 px-4 hidden sm:table-cell">Location & Salary</th>
                      <th className="py-3 px-4 hidden md:table-cell">Date Applied</th>
                      <th className="py-3 px-4">Notes</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0]">
                    {filteredApps.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[#64748B]">
                          No applications tracked yet. Click "Add application" to add one.
                        </td>
                      </tr>
                    ) : (
                      filteredApps.map((app) => (
                        <tr key={app.id} className="hover:bg-[#F8FAFC] transition-colors">
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-[#0F172A]">{app.title}</span>
                              <MatchScoreBadge
                                job={{
                                  id: app.id,
                                  title: app.title,
                                  company: app.company,
                                  location: app.location,
                                  salary_text: app.salaryText,
                                  apply_url: app.applyUrl,
                                }}
                                size="xs"
                              />
                            </div>
                            <div className="text-xs text-[#475569] flex items-center gap-1 mt-0.5">
                              <Building className="w-3 h-3 text-[#64748B]" />
                              <span>{app.company}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <select
                              value={app.stage}
                              onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                              className="text-xs font-semibold py-1.5 px-2.5 rounded-full border border-[#E2E8F0] bg-white text-[#0F172A] cursor-pointer min-h-[36px]"
                            >
                              {KANBAN_STAGES.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-3.5 px-4 hidden sm:table-cell text-xs text-[#475569]">
                            <div>{app.location || "Remote"}</div>
                            {app.salaryText && (
                              <div className="text-[#166534] font-medium text-xs">
                                {app.salaryText}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 hidden md:table-cell text-xs text-[#475569]">
                            {app.appliedAt ? new Date(app.appliedAt).toLocaleDateString() : "—"}
                          </td>
                          <td className="py-3.5 px-4">
                            <button
                              type="button"
                              onClick={() => handleOpenNotes(app)}
                              className="text-xs text-[#475569] hover:text-[#2563EB] flex items-center gap-1 cursor-pointer max-w-[150px] truncate min-h-[36px]"
                            >
                              <FileText className="w-3.5 h-3.5 shrink-0 text-[#94A3B8]" />
                              <span className="truncate">{app.notes || "Add notes..."}</span>
                            </button>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <div className="inline-flex items-center gap-2">
                              {sanitizeExternalUrl(app.applyUrl) && (
                                <a
                                  href={sanitizeExternalUrl(app.applyUrl)!}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 text-[#94A3B8] hover:text-[#2563EB] transition min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-[#F1F5F9]"
                                  title="Open Link"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDelete(app.id)}
                                className="p-1.5 text-[#94A3B8] hover:text-[#DC2626] transition cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-[#FEE2E2]"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty State Banner if no applications */}
          {applications.length === 0 && (
            <div className="bg-white rounded-[16px] p-8 sm:p-12 text-center ring-1 ring-[#E2E8F0] space-y-4 max-w-xl mx-auto shadow-none">
              <div className="w-12 h-12 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB] mx-auto flex items-center justify-center">
                <Sparkles className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-[#0F172A]">Your application pipeline is empty</h3>
                <p className="text-xs sm:text-sm text-[#475569]">
                  Track jobs from the 3D Radar or Job Directory, or click below to manually add an application.
                </p>
              </div>
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] text-white font-bold text-xs shadow-none hover:bg-[#1D4ED8] transition cursor-pointer"
                >
                  Track First Application
                </button>
                <Link
                  href="/jobs"
                  className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-full bg-[#F1F5F9] border border-[#E2E8F0] font-bold text-xs text-[#0F172A] hover:bg-[#E2E8F0] transition flex items-center justify-center"
                >
                  Browse Tech Jobs
                </Link>
              </div>
            </div>
          )}

      
      {/* MODAL 1: ADD APPLICATION */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-white rounded-[20px] ring-1 ring-[#E2E8F0] shadow-[0_16px_48px_rgba(15,23,42,0.18)] w-full max-w-md p-6 sm:p-5 space-y-4 sm:space-y-3 text-[#0F172A]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
              <h3 className="text-[16px] font-bold text-[#0F172A] flex items-center gap-2">
                <span>Track Job Application</span>
              </h3>
              <button
                aria-label="Close dialog"
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-[#94A3B8] hover:text-[#0F172A] p-1 min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateApplication} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#0F172A] mb-1">Company Name *</label>
                <input
                  aria-label="Company name"
                  type="text"
                  name="company"
                  value={newCompany}
                  onChange={(e) => {
                    setNewCompany(e.target.value);
                    if (formErrors.company) setFormErrors((prev) => ({ ...prev, company: undefined }));
                  }}
                  placeholder="e.g. Stripe, Airbnb, Datadog"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-[12px] border transition-colors bg-[#F8FAFC] focus:bg-white text-[#0F172A] ${
                    formErrors.company
                      ? "border-[#DC2626] focus:ring-2 focus:ring-[#DC2626] focus:outline-none"
                      : "border-[#CBD5E1] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                  }`}
                />
                {formErrors.company && (
                  <p className="text-xs text-[#DC2626] font-medium mt-1">{formErrors.company}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0F172A] mb-1">Job Title *</label>
                <input
                  aria-label="Job title"
                  type="text"
                  name="title"
                  value={newTitle}
                  onChange={(e) => {
                    setNewTitle(e.target.value);
                    if (formErrors.title) setFormErrors((prev) => ({ ...prev, title: undefined }));
                  }}
                  placeholder="e.g. Senior Full-Stack Engineer"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-[12px] border transition-colors bg-[#F8FAFC] focus:bg-white text-[#0F172A] ${
                    formErrors.title
                      ? "border-[#DC2626] focus:ring-2 focus:ring-[#DC2626] focus:outline-none"
                      : "border-[#CBD5E1] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                  }`}
                />
                {formErrors.title && (
                  <p className="text-xs text-[#DC2626] font-medium mt-1">{formErrors.title}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Location</label>
                  <input
                    aria-label="Location"
                    type="text"
                    value={newLocation}
                    onChange={(e) => setNewLocation(e.target.value)}
                    placeholder="Remote / City"
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] focus:bg-white text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Salary Band</label>
                  <input
                    aria-label="Salary band"
                    type="text"
                    value={newSalary}
                    onChange={(e) => setNewSalary(e.target.value)}
                    placeholder="e.g. $140k - $170k"
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] focus:bg-white text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Initial Stage</label>
                  <select
                    value={newStage}
                    onChange={(e) => setNewStage(e.target.value as ApplicationStage)}
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none cursor-pointer"
                  >
                    {KANBAN_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Job Link (URL)</label>
                  <input
                    aria-label="Job link URL"
                    type="url"
                    value={newApplyUrl}
                    onChange={(e) => setNewApplyUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] focus:bg-white text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0F172A] mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Recruiter contact, interview round info..."
                  className="w-full text-xs p-3 rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] focus:bg-white text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none resize-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-3 min-h-[44px]">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 min-h-[40px] text-xs font-semibold text-[#0F172A] bg-[#F1F5F9] hover:bg-[#E2E8F0] rounded-full transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 min-h-[40px] text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] rounded-full shadow-none transition cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                >
                  Save Application
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: NOTES EDITOR */}
      {activeNotesApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-white rounded-[20px] ring-1 ring-[#E2E8F0] shadow-[0_16px_48px_rgba(15,23,42,0.18)] w-full max-w-md p-6 sm:p-5 space-y-4 sm:space-y-3 text-[#0F172A]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
              <div>
                <h3 className="text-base font-bold text-[#0F172A]">
                  {activeNotesApp.company} Notes
                </h3>
                <p className="text-xs text-[#475569]">{activeNotesApp.title}</p>
              </div>
              <button
                aria-label="Close notes"
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="text-[#94A3B8] hover:text-[#0F172A] p-1 min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-[#475569]">
                Round notes, interviewer names, follow-up dates:
              </label>
              <textarea
                rows={5}
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="e.g. Chat with hiring manager scheduled for Thursday 2pm. Mentioned Go and Kubernetes architecture..."
                className="w-full text-xs sm:text-sm p-3 rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] focus:bg-white text-[#0F172A] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none resize-none"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-3 min-h-[44px]">
              <button
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="px-4 py-2 min-h-[40px] text-xs font-semibold text-[#0F172A] bg-[#F1F5F9] hover:bg-[#E2E8F0] rounded-full transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveNotes}
                className="px-5 py-2 min-h-[40px] text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] rounded-full shadow-none transition focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
              >
                Save Notes
              </button>
            </div>
          </div>
        </div>
      )}
    </LoggedInAppShell>
  );
}