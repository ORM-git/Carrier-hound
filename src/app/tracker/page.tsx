"use client";

import React, { useState, useEffect } from "react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
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
  CheckCircle2,
  AlertCircle,
  X,
  ChevronDown,
  Sparkles,
  ArrowRight,
  MapPin,
  DollarSign,
  Briefcase,
  Check,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTodayDigest, DigestMatchItem } from "@/lib/cron/digestStorage";
import { toast } from "react-toastify";
import MatchScoreBadge from "@/components/matcher/MatchScoreBadge";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";

export default function TrackerPage() {
  const router = useRouter();
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
      const [subRes, apps] = await Promise.all([
        getProAccessStatus(userId),
        getTrackedApplications(userId),
      ]);
      setIsPro(subRes.isPro);
      setIsProDefinitive(Boolean(subRes.isDefinitive));
      setApplications(apps);
    } catch (err: any) {
      console.error("Failed to load tracked applications", err);
      setLoadError(err?.message || "Could not retrieve saved applications. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?next=/tracker");
        return;
      }
      loadData(u.id);
      getTodayDigest().then((d) => setDigest(d));
    });

    const handleUpdate = () => {
      getAuthUser().then((u) => {
        if (u) loadData(u.id);
      });
    };

    window.addEventListener("careermonke_tracker_updated", handleUpdate);
    return () => {
      window.removeEventListener("careermonke_tracker_updated", handleUpdate);
    };
  }, [router]);

  const handleAddDigestToPipeline = async (item: DigestMatchItem) => {
    await addApplicationToTracker({
      jobId: item.jobId,
      company: item.company,
      title: item.title,
      location: item.location,
      salaryText: item.salaryText,
      applyUrl: item.applyUrl,
      stage: "saved",
      notes: `Matched by Daily Cron with ${item.score}% score. Matched skills: ${item.matchedSkills.join(", ")}`,
    });
    loadData();
  };

  const handleRefreshScan = async () => {
    setIsScanningDigest(true);
    try {
      const d = await getTodayDigest();
      setDigest(d);
      setShowDigest(true);
      toast.success(`AI Scan complete! Found ${d.matches.length} matched roles.`);
    } catch (e) {
      toast.error("Could not complete scan.");
    } finally {
      setIsScanningDigest(false);
    }
  };



  // Filtered applications
  const filteredApps = applications.filter((app) => {
    const q = searchQuery.toLowerCase();
    return (
      app.company.toLowerCase().includes(q) ||
      app.title.toLowerCase().includes(q) ||
      (app.location && app.location.toLowerCase().includes(q)) ||
      (app.notes && app.notes.toLowerCase().includes(q))
    );
  });

  // Drag and Drop handlers
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedAppId(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, stage: ApplicationStage) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
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
    const id = draggedAppId || e.dataTransfer.getData("text/plain");
    if (!id) return;

    setDraggedAppId(null);
    await updateApplicationStage(id, targetStage);
    loadData();
  };

  // Quick stage changer for mobile or touch
  const handleStageSelect = async (id: string, stage: ApplicationStage) => {
    await updateApplicationStage(id, stage);
    loadData();
  };

  // Notes management
  const handleOpenNotes = (app: TrackedApplication) => {
    setActiveNotesApp(app);
    setNotesDraft(app.notes || "");
  };

  const handleSaveNotes = async () => {
    if (!activeNotesApp) return;
    await updateApplicationNotes(activeNotesApp.id, notesDraft);
    setActiveNotesApp(null);
    loadData();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Remove this job application from tracker?")) {
      await deleteApplicationFromTracker(id);
      loadData();
    }
  };

  // Add new application with inline validation
  const handleCreateApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { title?: string; company?: string } = {};
    if (!newCompany.trim()) {
      errors.company = "Company name is required.";
    }
    if (!newTitle.trim()) {
      errors.title = "Job title is required.";
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setFormErrors({});

    await addApplicationToTracker({
      company: newCompany.trim(),
      title: newTitle.trim(),
      location: newLocation.trim() || undefined,
      salaryText: newSalary.trim() || undefined,
      applyUrl: newApplyUrl.trim() || undefined,
      stage: newStage,
      notes: newNotes.trim() || undefined,
      appliedAt: newStage === "applied" ? new Date().toISOString() : undefined,
    });

    // Reset form
    setNewTitle("");
    setNewCompany("");
    setNewLocation("");
    setNewSalary("");
    setNewApplyUrl("");
    setNewStage("saved");
    setNewNotes("");
    setIsAddModalOpen(false);
    loadData();
  };


  const stageCounts = KANBAN_STAGES.reduce<Record<ApplicationStage, number>>(
    (acc, stage) => {
      acc[stage.id] = applications.filter((a) => a.stage === stage.id).length;
      return acc;
    },
    { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 }
  );

  if (isLoading || (!isPro && !isProDefinitive)) {
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
        <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
          <ProUpgradeScreen
            title="Unlock Application Tracker"
            subtitle="Upgrade to CareerMonke Pro to save jobs, track interview stages, and manage your pipeline."
          />
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col justify-between selection:bg-blue-100 selection:text-blue-900">
      <GuideHeader />

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6">
        {/* Top Control Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse" />
              <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
                Application Pipeline Tracker
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Organize, track, and manage your job applications across every hiring round.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* View Mode Toggle */}
            <div className="bg-slate-200/80 p-1 rounded-xl flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode("kanban")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  viewMode === "kanban"
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Kanban</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  viewMode === "list"
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <List className="w-3.5 h-3.5" />
                <span>List</span>
              </button>
            </div>

            {/* Quick Add Button */}
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition cursor-pointer min-h-[40px]"
            >
              <Plus className="w-4 h-4" />
              <span>Track Job</span>
            </button>
          </div>
        </div>

        {/* Daily Automated Digest Banner (v1.2 Cron) */}
        <div className="bg-gradient-to-r from-blue-50 via-indigo-50 to-cyan-50 border border-blue-200 rounded-2xl p-4 sm:p-5 shadow-2xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs shrink-0">
                <Sparkles className="w-5 h-5 text-yellow-300" />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-900 flex items-center gap-2">
                  <span>Daily AI Matching Digest</span>
                  {digest && digest.matches.length > 0 && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                      {digest.matches.length} Top Roles
                    </span>
                  )}
                </h3>
                <p className="text-xs text-slate-600">
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.98] text-white text-xs font-bold transition shadow-2xs cursor-pointer disabled:opacity-60"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isScanningDigest ? "animate-spin" : ""}`} />
                <span>{isScanningDigest ? "Scanning..." : "⚡ Run AI Scan"}</span>
              </button>

              {digest && digest.matches.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowDigest(!showDigest)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[38px] rounded-xl bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 text-xs font-bold transition shadow-2xs cursor-pointer"
                >
                  <span>{showDigest ? "Hide Digest" : "Show Digest"}</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDigest ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
          </div>

          {showDigest && digest && digest.matches.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-blue-100 animate-fadeIn">

                {digest.matches.map((item) => (
                  <div
                    key={item.jobId}
                    className="bg-white rounded-xl p-3.5 border border-blue-100 shadow-2xs space-y-2 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="font-bold text-xs text-slate-900 line-clamp-1">{item.title}</span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 shrink-0">
                          {item.score}% Match
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 font-medium">{item.company} • {item.location}</div>
                      {item.matchedSkills.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {item.matchedSkills.slice(0, 3).map((s) => (
                            <span key={s} className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="pt-2 border-t border-slate-50 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleAddDigestToPipeline(item)}
                        className="text-[11px] font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Add to Saved</span>
                      </button>

                      {item.applyUrl && (
                        <a
                          href={item.applyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-0.5"
                        >
                          <span>Apply</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : showDigest ? (
              <div className="pt-3 pb-1 border-t border-blue-100 text-center">
                <p className="text-xs text-slate-500">
                  No matching roles generated yet for today. Click <strong className="text-slate-800">&quot;⚡ Run AI Scan&quot;</strong> above to scan unindexed listings against your resume!
                </p>
              </div>
            ) : null}
          </div>


        {/* Search & Statistics Ribbon */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              aria-label="Search by company, role, or notes"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by company, role, or notes..."
              className="w-full text-xs sm:text-sm pl-10 pr-4 py-2 rounded-xl border border-slate-300 bg-white focus:outline-blue-500 shadow-2xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 text-xs text-slate-600">
            <span className="font-semibold text-slate-400 shrink-0">Total: {applications.length}</span>
            <span className="text-slate-300">•</span>
            <span className="shrink-0">{stageCounts.applied} Applied</span>
            <span className="text-slate-300">•</span>
            <span className="shrink-0 font-medium text-amber-600">{stageCounts.interview} Interview</span>
            <span className="text-slate-300">•</span>
            <span className="shrink-0 font-medium text-emerald-600">{stageCounts.offer} Offer</span>
          </div>
        </div>

        {/* Loading Skeleton */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 items-start">
            {[1, 2, 3, 4, 5].map((colIndex) => (
              <div
                key={colIndex}
                className="bg-slate-100/70 rounded-2xl p-3 border border-slate-200 min-h-[420px] flex flex-col space-y-3 animate-pulse"
              >
                <div className="flex items-center justify-between pb-3 px-1 border-b border-slate-200/80">
                  <div className="h-4 bg-slate-300 rounded w-20" />
                  <div className="h-4 w-6 bg-slate-200 rounded-full" />
                </div>
                <div className="bg-white rounded-xl p-3.5 border border-slate-200 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                  <div className="h-3 bg-slate-100 rounded w-1/2" />
                  <div className="h-6 bg-slate-100 rounded w-full mt-2" />
                </div>
                <div className="bg-white rounded-xl p-3.5 border border-slate-200 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-2/3" />
                  <div className="h-3 bg-slate-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          /* Error State with Retry */
          <div className="bg-white border border-rose-200 rounded-2xl p-8 sm:p-12 text-center space-y-4 max-w-xl mx-auto shadow-xs">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 mx-auto flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-slate-900">Unable to Load Tracker Pipeline</h3>
              <p className="text-xs sm:text-sm text-slate-600">{loadError}</p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => loadData()}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs shadow-xs transition cursor-pointer"
              >
                <span>Retry Connection</span>
              </button>
            </div>
          </div>
        ) : viewMode === "kanban" ? (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 items-start">
            {KANBAN_STAGES.map((col) => {
              const colApps = filteredApps.filter((a) => a.stage === col.id);
              const isDropTarget = dropTargetStage === col.id;

              return (
                <div
                  key={col.id}
                  onDragOver={(e) => handleDragOver(e, col.id)}
                  onDragLeave={() => handleDragLeave(col.id)}
                  onDrop={(e) => handleDrop(e, col.id)}
                  className={`bg-slate-100/70 rounded-2xl p-3 border transition-colors min-h-[500px] flex flex-col ${
                    isDropTarget
                      ? "border-blue-400 bg-blue-50/50 ring-2 ring-blue-300"
                      : "border-slate-200"
                  }`}
                >

                  {/* Column Header */}
                  <div className="flex items-center justify-between pb-3 px-1 border-b border-slate-200/80 mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${col.badgeColor}`} />
                      <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        {col.label}
                      </span>
                    </div>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200 shadow-2xs">
                      {colApps.length}
                    </span>
                  </div>

                  {/* Cards List */}
                  <div className="space-y-3 flex-1 overflow-y-auto">
                    {colApps.length === 0 ? (
                      <div className="h-32 border-2 border-dashed border-slate-200 rounded-xl flex items-center justify-center p-4 text-center">
                        <span className="text-xs text-slate-400 font-medium">
                          Drop applications here
                        </span>
                      </div>
                    ) : (
                      colApps.map((app) => (
                        <div
                          key={app.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, app.id)}
                          className="bg-white rounded-xl p-3.5 border border-slate-200 shadow-2xs hover:shadow-md transition-all cursor-grab active:cursor-grabbing space-y-2.5 group"
                        >
                          {/* Role & Company */}
                          <div>
                            <div className="flex items-start justify-between gap-1.5">
                              <h4 className="text-xs sm:text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors line-clamp-2">
                                {app.title}
                              </h4>
                              <button
                                type="button"
                                onClick={() => handleDelete(app.id)}
                                className="text-slate-300 hover:text-red-500 transition p-0.5 cursor-pointer shrink-0"
                                title="Remove application"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center justify-between gap-1.5 mt-1">
                              <div className="flex items-center gap-1.5 text-xs text-slate-600 font-medium truncate">
                                <Building className="w-3 h-3 text-slate-400 shrink-0" />
                                <span className="truncate">{app.company}</span>
                              </div>
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
                          </div>

                          {/* Meta: Location or Salary */}
                          {(app.location || app.salaryText) && (
                            <div className="space-y-1 text-[11px] text-slate-500">
                              {app.location && (
                                <div className="flex items-center gap-1 truncate">
                                  <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                                  <span className="truncate">{app.location}</span>
                                </div>
                              )}
                              {app.salaryText && (
                                <div className="flex items-center gap-1 text-emerald-700 font-medium truncate">
                                  <DollarSign className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{app.salaryText}</span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Applied Date if set */}
                          {app.appliedAt && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-400">
                              <Calendar className="w-3 h-3" />
                              <span>Applied: {new Date(app.appliedAt).toLocaleDateString()}</span>
                            </div>
                          )}

                          {/* Notes Preview if available */}
                          {app.notes && (
                            <div
                              onClick={() => handleOpenNotes(app)}
                              className="p-2 bg-slate-50 rounded-lg border border-slate-100 text-[11px] text-slate-600 line-clamp-2 cursor-pointer hover:bg-slate-100 transition"
                              title="Click to edit notes"
                            >
                              <span className="font-semibold text-slate-700 mr-1">Note:</span>
                              {app.notes}
                            </div>
                          )}

                          {/* Actions Bottom Bar */}
                          <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                            {/* Mobile Stage Selector Dropdown */}
                            <select
                              value={app.stage}
                              onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                              className="text-[10px] font-semibold py-1 px-1.5 rounded-md border border-slate-200 bg-slate-50 text-slate-700 focus:outline-blue-500 cursor-pointer"
                            >
                              {KANBAN_STAGES.map((s) => (
                                <option key={s.id} value={s.id}>
                                  Move to: {s.label}
                                </option>
                              ))}
                            </select>

                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleOpenNotes(app)}
                                className="p-1 text-slate-400 hover:text-blue-600 transition cursor-pointer"
                                title="Add/Edit Notes"
                              >
                                <FileText className="w-3.5 h-3.5" />
                              </button>

                              {app.applyUrl && (
                                <a
                                  href={app.applyUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1 text-slate-400 hover:text-blue-600 transition"
                                  title="Open Official Job Page"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* View Mode 2: LIST / TABLE VIEW */
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase text-[11px] tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Company & Role</th>
                    <th className="py-3 px-4">Stage</th>
                    <th className="py-3 px-4 hidden sm:table-cell">Location & Salary</th>
                    <th className="py-3 px-4 hidden md:table-cell">Date Applied</th>
                    <th className="py-3 px-4">Notes</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredApps.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        No applications tracked yet. Click "Track Job" to add one.
                      </td>
                    </tr>
                  ) : (
                    filteredApps.map((app) => (
                      <tr key={app.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{app.title}</span>
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
                          <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                            <Building className="w-3 h-3" />
                            <span>{app.company}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <select
                            value={app.stage}
                            onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                            className="text-xs font-semibold py-1 px-2 rounded-lg border border-slate-200 bg-white text-slate-700 cursor-pointer"
                          >
                            {KANBAN_STAGES.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3.5 px-4 hidden sm:table-cell text-xs text-slate-600">
                          <div>{app.location || "Remote"}</div>
                          {app.salaryText && (
                            <div className="text-emerald-700 font-medium text-[11px]">
                              {app.salaryText}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 hidden md:table-cell text-xs text-slate-500">
                          {app.appliedAt ? new Date(app.appliedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="py-3.5 px-4">
                          <button
                            type="button"
                            onClick={() => handleOpenNotes(app)}
                            className="text-xs text-slate-600 hover:text-blue-600 flex items-center gap-1 cursor-pointer max-w-[150px] truncate"
                          >
                            <FileText className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                            <span className="truncate">{app.notes || "Add notes..."}</span>
                          </button>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="inline-flex items-center gap-2">
                            {app.applyUrl && (
                              <a
                                href={app.applyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 text-slate-400 hover:text-blue-600 transition"
                                title="Open Link"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDelete(app.id)}
                              className="p-1.5 text-slate-400 hover:text-red-500 transition cursor-pointer"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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
          <div className="bg-white rounded-2xl p-8 sm:p-12 text-center border border-slate-200 space-y-4 max-w-xl mx-auto">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 mx-auto flex items-center justify-center">
              <Sparkles className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-slate-900">Your application pipeline is empty</h3>
              <p className="text-xs sm:text-sm text-slate-500">
                Track jobs from the 3D Radar or Job Directory, or click below to manually add an application.
              </p>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setIsAddModalOpen(true)}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[#2563EB] text-white font-bold text-xs shadow-sm hover:bg-[#1D4ED8] transition cursor-pointer"
              >
                Track First Application
              </button>
              <Link
                href="/job-search/all"
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-300 font-bold text-xs text-slate-700 hover:bg-slate-50 transition"
              >
                Browse Tech Jobs
              </Link>
            </div>
          </div>
        )}
      </main>

      {/* MODAL 1: ADD APPLICATION */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-blue-600" />
                <span>Track Job Application</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateApplication} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Company Name *</label>
                <input
                  type="text"
                  value={newCompany}
                  onChange={(e) => {
                    setNewCompany(e.target.value);
                    if (formErrors.company) setFormErrors((prev) => ({ ...prev, company: undefined }));
                  }}
                  placeholder="e.g. Stripe, Airbnb, Datadog"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-xl border transition-colors ${
                    formErrors.company
                      ? "border-rose-500 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                      : "border-slate-300 focus:outline-blue-500"
                  }`}
                />
                {formErrors.company && (
                  <p className="text-[11px] text-rose-600 font-medium mt-1">{formErrors.company}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Job Title *</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => {
                    setNewTitle(e.target.value);
                    if (formErrors.title) setFormErrors((prev) => ({ ...prev, title: undefined }));
                  }}
                  placeholder="e.g. Senior Full-Stack Engineer"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-xl border transition-colors ${
                    formErrors.title
                      ? "border-rose-500 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                      : "border-slate-300 focus:outline-blue-500"
                  }`}
                />
                {formErrors.title && (
                  <p className="text-[11px] text-rose-600 font-medium mt-1">{formErrors.title}</p>
                )}
              </div>


              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Location</label>
                  <input
                    type="text"
                    value={newLocation}
                    onChange={(e) => setNewLocation(e.target.value)}
                    placeholder="Remote / City"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-slate-300 focus:outline-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Salary Band</label>
                  <input
                    type="text"
                    value={newSalary}
                    onChange={(e) => setNewSalary(e.target.value)}
                    placeholder="e.g. $140k - $170k"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-slate-300 focus:outline-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Initial Stage</label>
                  <select
                    value={newStage}
                    onChange={(e) => setNewStage(e.target.value as ApplicationStage)}
                    className="w-full text-xs px-3 py-2 rounded-xl border border-slate-300 bg-white focus:outline-blue-500"
                  >
                    {KANBAN_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Job Link (URL)</label>
                  <input
                    type="url"
                    value={newApplyUrl}
                    onChange={(e) => setNewApplyUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full text-xs px-3 py-2 rounded-xl border border-slate-300 focus:outline-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Recruiter contact, interview round info..."
                  className="w-full text-xs px-3 py-2 rounded-xl border border-slate-300 focus:outline-blue-500 resize-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2.5 min-h-[44px] text-xs font-bold text-slate-600 hover:bg-slate-100 active:scale-[0.98] rounded-xl transition-all duration-150 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 min-h-[44px] text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] active:scale-[0.98] rounded-xl shadow-xs transition-all duration-150 cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md p-6 space-y-4 animate-scaleUp">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {activeNotesApp.company} Notes
                </h3>
                <p className="text-xs text-slate-500">{activeNotesApp.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-600">
                Round notes, interviewer names, follow-up dates:
              </label>
              <textarea
                rows={5}
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="e.g. Chat with hiring manager scheduled for Thursday 2pm. Mentioned Go and Kubernetes architecture..."
                className="w-full text-xs sm:text-sm p-3 rounded-xl border border-slate-300 focus:outline-blue-500 resize-none"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveNotes}
                className="px-5 py-2 text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] rounded-xl shadow-xs"
              >
                Save Notes
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
