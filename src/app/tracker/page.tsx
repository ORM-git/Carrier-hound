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
  CheckCircle2,
  AlertCircle,
  X,
  ChevronDown,
  Sparkles,
  ArrowRight,
  MapPin,
  DollarSign,
  Briefcase,
  Globe,
  User as UserIcon,
  CheckSquare,
  BookOpen,
  MessageSquare,
  Settings,
} from "lucide-react";
import BrandIcon from "@/components/BrandIcon";
import Footer from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cnTokens } from "@/components/ui/cn-tokens";
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
      setUser(u);
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
    loadData(user?.id);
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
    loadData(user?.id);
  };

  // Quick stage changer for mobile or touch
  const handleStageSelect = async (id: string, stage: ApplicationStage) => {
    await updateApplicationStage(id, stage);
    loadData(user?.id);
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
    loadData(user?.id);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Remove this job application from tracker?")) {
      await deleteApplicationFromTracker(id);
      loadData(user?.id);
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
    loadData(user?.id);
  };

  const stageCounts = KANBAN_STAGES.reduce<Record<ApplicationStage, number>>(
    (acc, stage) => {
      acc[stage.id] = applications.filter((a) => a.stage === stage.id).length;
      return acc;
    },
    { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 }
  );

  // Loading skeleton matching the dashboard shell
  if (isLoading || (!isPro && !isProDefinitive)) {
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
        {/* Desktop Sidebar Skeleton */}
        <aside className="hidden lg:flex flex-col justify-between w-[220px] fixed top-0 bottom-0 left-0 bg-surface border-r border-line z-30 p-4">
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <Skeleton className="w-8 h-8 rounded-tk-lg" />
              <Skeleton className="h-6 w-28 rounded-tk-md" />
            </div>
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-11 w-full rounded-tk-lg" />
              ))}
            </div>
          </div>
        </aside>

        {/* Content Skeleton */}
        <div className="flex-1 lg:pl-[220px] flex flex-col min-w-0">
          <header className="lg:hidden sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-line px-4 h-14 flex items-center justify-between">
            <Skeleton className="h-7 w-32 rounded-tk-md" />
            <Skeleton className="w-9 h-9 rounded-tk-full" />
          </header>
          <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-64 rounded-tk-md" />
              <Skeleton className="h-11 w-36 rounded-tk-lg" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Card key={i} variant="surface" className="min-h-[420px] p-3 space-y-3">
                  <Skeleton className="h-5 w-24 rounded-tk-md" />
                  <Skeleton className="h-28 w-full rounded-tk-lg" />
                  <Skeleton className="h-28 w-full rounded-tk-lg" />
                </Card>
              ))}
            </div>
          </main>
        </div>
      </div>
    );
  }

  // Definitively non-Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col justify-between">
        {/* Desktop Sidebar Shell */}
        <aside className="hidden lg:flex flex-col justify-between w-[220px] fixed top-0 bottom-0 left-0 bg-surface border-r border-line z-30 p-4">
          <div className="space-y-6">
            <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-tk-lg bg-surface flex items-center justify-center p-1 shadow-tk-xs border border-line">
                <BrandIcon className="w-6 h-6" />
              </div>
              <span className="text-lg font-black text-brand-600 tracking-tight">
                CareerMonke
              </span>
            </Link>

            <nav className="space-y-1">
              <Link
                href="/jobs"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
              >
                <Briefcase className="w-4 h-4 text-ink-subtle shrink-0" />
                <span>Jobs</span>
              </Link>
              <Link
                href="/radar"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
              >
                <Globe className="w-4 h-4 text-ink-subtle shrink-0" />
                <span>Explore</span>
              </Link>
              <Link
                href="/resume"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
              >
                <FileText className="w-4 h-4 text-ink-subtle shrink-0" />
                <span>Resume</span>
              </Link>
              <Link
                href="/settings?tab=preferences"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
              >
                <UserIcon className="w-4 h-4 text-ink-subtle shrink-0" />
                <span>Profile</span>
              </Link>
              <Link
                href="/applications"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-bold transition min-h-[44px] bg-brand-50 text-brand-700 shadow-tk-xs"
              >
                <CheckSquare className="w-4 h-4 text-brand-600 shrink-0" />
                <span>Applications</span>
              </Link>
              <Link
                href="/remote"
                className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
              >
                <BookOpen className="w-4 h-4 text-ink-subtle shrink-0" />
                <span>Resources</span>
              </Link>
            </nav>
          </div>
        </aside>

        <div className="flex-1 lg:pl-[220px] flex flex-col min-w-0">
          <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
            <ProUpgradeScreen
              title="Unlock Application Tracker"
              subtitle="Upgrade to CareerMonke Pro to save jobs, track interview stages, and manage your pipeline."
            />
          </main>
          <Footer />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
      {/* ========================================================================= */}
      {/* 1. LEFT SIDEBAR (Desktop Fixed 220px)                                     */}
      {/* ========================================================================= */}
      <aside className="hidden lg:flex flex-col justify-between w-[220px] fixed top-0 bottom-0 left-0 bg-surface border-r border-line z-30 p-4">
        <div className="space-y-6">
          {/* Logo */}
          <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-tk-lg bg-surface flex items-center justify-center p-1 shadow-tk-xs border border-line">
              <BrandIcon className="w-6 h-6" />
            </div>
            <span className="text-lg font-black text-brand-600 tracking-tight">
              CareerMonke
            </span>
          </Link>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <Link
              href="/jobs"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <Briefcase className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Jobs</span>
            </Link>

            <Link
              href="/radar"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <Globe className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Explore</span>
            </Link>

            <Link
              href="/resume"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <FileText className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Resume</span>
            </Link>

            <Link
              href="/settings?tab=preferences"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <UserIcon className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Profile</span>
            </Link>

            <Link
              href="/applications"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-bold transition min-h-[44px] bg-brand-50 text-brand-700 shadow-tk-xs"
            >
              <CheckSquare className="w-4 h-4 text-brand-600 shrink-0" />
              <span>Applications</span>
            </Link>

            <Link
              href="/remote"
              className="flex items-center gap-3 px-3 py-2.5 rounded-tk-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <BookOpen className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Resources</span>
            </Link>
          </nav>
        </div>

        {/* Bottom Promo & Controls */}
        <div className="space-y-3 pt-4 border-t border-line">
          {/* Pro Upgrade / Status Card */}
          <div className="p-3 rounded-tk-xl bg-brand-50/70 border border-brand-200 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-900">
              <Sparkles className="w-3.5 h-3.5 text-brand-600 shrink-0" />
              <span>CareerMonke Pro</span>
            </div>
            <p className="text-xs text-ink-muted leading-snug">
              Direct ATS endpoints, verified salary bands, and AI match diagnostics.
            </p>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:text-brand-800 transition pt-0.5 min-h-[32px]"
            >
              <span>View Plans</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {/* Feedback & Settings */}
          <div className="space-y-0.5">
            <a
              href="mailto:support@careermonke.com"
              className="flex items-center gap-2.5 px-3 py-2 rounded-tk-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <MessageSquare className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Feedback</span>
            </a>

            <Link
              href="/settings"
              className="flex items-center gap-2.5 px-3 py-2 rounded-tk-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted transition min-h-[44px]"
            >
              <Settings className="w-4 h-4 text-ink-subtle shrink-0" />
              <span>Settings</span>
            </Link>
          </div>
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* MOBILE TOP BAR (<900px)                                                   */}
      {/* ========================================================================= */}
      <header className="lg:hidden sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-line px-4 h-14 flex items-center justify-between">
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2 min-h-[44px]">
          <div className="w-7 h-7 rounded-tk-full bg-surface flex items-center justify-center p-0.5 shadow-tk-xs border border-line">
            <BrandIcon className="w-6 h-6" />
          </div>
          <span className="text-base font-black text-brand-600 tracking-tight">CareerMonke</span>
        </Link>
        <div className="flex items-center gap-2">
          {!user ? (
            <Link
              href="/login"
              className="text-xs font-bold text-brand-600 px-3 py-1.5 rounded-tk-lg border border-brand-200 bg-brand-50 min-h-[44px] flex items-center"
            >
              Sign In
            </Link>
          ) : (
            <Link
              href="/settings"
              className="w-9 h-9 rounded-tk-full bg-brand-600 text-ink-inverse font-bold text-xs flex items-center justify-center min-h-[44px] min-w-[44px]"
            >
              {(user.email || "CM").slice(0, 2).toUpperCase()}
            </Link>
          )}
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. MAIN CONTENT AREA (offset by 220px on desktop)                         */}
      {/* ========================================================================= */}
      <div className="flex-1 lg:pl-[220px] flex flex-col min-w-0">
        <main
          id="main-content"
          className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-4 pb-24 lg:pb-12"
        >
          {/* Top Control Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-tk-full bg-brand-600 animate-pulse" />
                <h1 className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                  Application Pipeline Tracker
                </h1>
              </div>
              <p className="text-xs sm:text-sm text-ink-muted mt-1">
                Organize, track, and manage your job applications across every hiring round.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {/* View Mode Toggle */}
              <div className="bg-surface-muted p-1 rounded-tk-xl border border-line flex items-center gap-1 min-h-[44px]">
                <button
                  type="button"
                  onClick={() => setViewMode("kanban")}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-tk-lg text-xs font-bold transition cursor-pointer min-h-[36px] ${
                    viewMode === "kanban"
                      ? "bg-surface text-ink shadow-tk-xs border border-line"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <LayoutGrid className="w-4 h-4" />
                  <span>Kanban</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-tk-lg text-xs font-bold transition cursor-pointer min-h-[36px] ${
                    viewMode === "list"
                      ? "bg-surface text-ink shadow-tk-xs border border-line"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <List className="w-4 h-4" />
                  <span>List</span>
                </button>
              </div>

              {/* Add Application Button */}
              <button
                type="button"
                onClick={() => setIsAddModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-tk-xl text-xs sm:text-sm font-bold bg-brand-600 hover:bg-brand-700 text-ink-inverse shadow-tk-xs transition cursor-pointer min-h-[44px]"
              >
                <Plus className="w-4 h-4" />
                <span>+ Add Application</span>
              </button>
            </div>
          </div>

          {/* Daily Automated Digest Banner */}
          <div className="bg-surface rounded-tk-2xl border border-line p-4 sm:p-5 shadow-tk-xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-tk-xl bg-brand-600 text-ink-inverse flex items-center justify-center shadow-tk-xs shrink-0">
                  <Sparkles className="w-5 h-5 text-yellow-300" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-ink flex items-center gap-2">
                    <span>Daily AI Matching Digest</span>
                    {digest && digest.matches.length > 0 && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-tk-full bg-brand-50 text-brand-700 border border-brand-200">
                        {digest.matches.length} Top Roles
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-ink-muted">
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
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-tk-xl bg-brand-600 hover:bg-brand-700 text-ink-inverse text-xs font-bold transition shadow-tk-xs cursor-pointer disabled:opacity-60"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isScanningDigest ? "animate-spin" : ""}`} />
                  <span>{isScanningDigest ? "Scanning..." : "⚡ Run AI Scan"}</span>
                </button>

                {digest && digest.matches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowDigest(!showDigest)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-tk-xl bg-surface border border-line text-ink hover:bg-surface-muted text-xs font-bold transition shadow-tk-xs cursor-pointer"
                  >
                    <span>{showDigest ? "Hide Digest" : "Show Digest"}</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDigest ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            </div>

            {showDigest && digest && digest.matches.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3 border-t border-line animate-fadeIn">
                {digest.matches.map((item) => (
                  <div
                    key={item.jobId}
                    className="bg-surface-subtle rounded-tk-xl p-3.5 border border-line shadow-tk-xs space-y-2 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="font-bold text-xs text-ink line-clamp-1">{item.title}</span>
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-tk-md bg-success-50 text-success-700 border border-success-200 shrink-0">
                          {item.score}% Match
                        </span>
                      </div>
                      <div className="text-xs text-ink-muted font-medium">{item.company} • {item.location}</div>
                      {item.matchedSkills.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {item.matchedSkills.slice(0, 3).map((s) => (
                            <span key={s} className="text-xs bg-surface text-ink-muted px-1.5 py-0.5 rounded-tk-md border border-line">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="pt-2 border-t border-line flex items-center justify-between gap-2 min-h-[40px]">
                      <button
                        type="button"
                        onClick={() => handleAddDigestToPipeline(item)}
                        className="text-xs font-bold text-brand-600 hover:text-brand-800 flex items-center gap-1 cursor-pointer min-h-[40px]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add to Saved</span>
                      </button>

                      {sanitizeExternalUrl(item.applyUrl) && (
                        <a
                          href={sanitizeExternalUrl(item.applyUrl)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-ink-muted hover:text-ink flex items-center gap-0.5 min-h-[40px]"
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
              <div className="pt-3 pb-1 border-t border-line text-center">
                <p className="text-xs text-ink-muted">
                  No matching roles generated yet for today. Click <strong className="text-ink">&quot;⚡ Run AI Scan&quot;</strong> above to scan unindexed listings against your resume!
                </p>
              </div>
            ) : null}
          </div>

          {/* Search & Statistics Ribbon */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input
                type="text"
                aria-label="Search by company, role, or notes"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by company, role, or notes..."
                className="w-full text-xs sm:text-sm pl-10 pr-4 py-2.5 min-h-[44px] rounded-tk-xl border border-line bg-surface focus:outline-brand-600 shadow-tk-xs text-ink"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle hover:text-ink text-xs min-h-[32px] px-2"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 text-xs text-ink-muted">
              <span className="font-semibold text-ink-subtle shrink-0">Total: {applications.length}</span>
              <span className="text-line-strong">•</span>
              <span className="shrink-0">{stageCounts.applied} Applied</span>
              <span className="text-line-strong">•</span>
              <span className="shrink-0 font-medium text-warning-700">{stageCounts.interview} Interview</span>
              <span className="text-line-strong">•</span>
              <span className="shrink-0 font-medium text-success-700">{stageCounts.offer} Offer</span>
            </div>
          </div>

          {/* Error State with Retry */}
          {loadError ? (
            <div className="bg-surface border border-danger-200 rounded-tk-2xl p-8 sm:p-12 text-center space-y-4 max-w-xl mx-auto shadow-tk-xs">
              <div className="w-12 h-12 rounded-tk-2xl bg-danger-50 text-danger-600 mx-auto flex items-center justify-center">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-ink">Unable to Load Tracker Pipeline</h3>
                <p className="text-xs sm:text-sm text-ink-muted">{loadError}</p>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => loadData(user?.id)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] rounded-tk-xl bg-brand-600 hover:bg-brand-700 text-ink-inverse font-bold text-xs shadow-tk-xs transition cursor-pointer"
                >
                  <span>Retry Connection</span>
                </button>
              </div>
            </div>
          ) : viewMode === "kanban" ? (
            /* View Mode 1: KANBAN BOARD */
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
                    className={`bg-surface-subtle rounded-tk-2xl p-3 border transition-colors min-h-[500px] flex flex-col ${
                      isDropTarget
                        ? "border-brand-500 bg-brand-50/50 ring-2 ring-brand-300"
                        : "border-line"
                    }`}
                  >
                    {/* Column Header */}
                    <div className="flex items-center justify-between pb-3 px-1 border-b border-line mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-tk-full ${col.badgeColor}`} />
                        <span className="text-xs font-bold text-ink uppercase tracking-wider">
                          {col.label}
                        </span>
                      </div>
                      <span className="text-xs font-bold px-2 py-0.5 rounded-tk-full bg-surface text-ink-muted border border-line shadow-tk-xs">
                        {colApps.length}
                      </span>
                    </div>

                    {/* Cards List */}
                    <div className="space-y-3 flex-1 overflow-y-auto">
                      {colApps.length === 0 ? (
                        <div className="h-32 border-2 border-dashed border-line rounded-tk-xl flex items-center justify-center p-4 text-center">
                          <span className="text-xs text-ink-subtle font-medium">
                            Drop applications here
                          </span>
                        </div>
                      ) : (
                        colApps.map((app) => (
                          <div
                            key={app.id}
                            draggable
                            onDragStart={(e) => handleDragStart(e, app.id)}
                            className="bg-surface rounded-tk-xl p-3.5 border border-line shadow-tk-xs hover:shadow-tk-md transition-all cursor-grab active:cursor-grabbing space-y-2.5 group"
                          >
                            {/* Role & Company */}
                            <div>
                              <div className="flex items-start justify-between gap-1.5">
                                <h4 className="text-xs sm:text-sm font-bold text-ink group-hover:text-brand-600 transition-colors line-clamp-2">
                                  {app.title}
                                </h4>
                                <button
                                  type="button"
                                  onClick={() => handleDelete(app.id)}
                                  className="text-ink-subtle hover:text-danger-600 transition p-1 cursor-pointer shrink-0 min-h-[32px] min-w-[32px] flex items-center justify-center"
                                  title="Remove application"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="flex items-center justify-between gap-1.5 mt-1">
                                <div className="flex items-center gap-1.5 text-xs text-ink-muted font-medium truncate">
                                  <Building className="w-3.5 h-3.5 text-ink-subtle shrink-0" />
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
                              <div className="space-y-1 text-xs text-ink-muted">
                                {app.location && (
                                  <div className="flex items-center gap-1 truncate">
                                    <MapPin className="w-3 h-3 text-ink-subtle shrink-0" />
                                    <span className="truncate">{app.location}</span>
                                  </div>
                                )}
                                {app.salaryText && (
                                  <div className="flex items-center gap-1 text-success-700 font-medium truncate">
                                    <DollarSign className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{app.salaryText}</span>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Applied Date if set */}
                            {app.appliedAt && (
                              <div className="flex items-center gap-1 text-xs text-ink-subtle">
                                <Calendar className="w-3 h-3" />
                                <span>Applied: {new Date(app.appliedAt).toLocaleDateString()}</span>
                              </div>
                            )}

                            {/* Notes Preview if available */}
                            {app.notes && (
                              <div
                                onClick={() => handleOpenNotes(app)}
                                className="p-2 bg-surface-muted rounded-tk-lg border border-line text-xs text-ink-muted line-clamp-2 cursor-pointer hover:bg-surface transition"
                                title="Click to edit notes"
                              >
                                <span className="font-semibold text-ink mr-1">Note:</span>
                                {app.notes}
                              </div>
                            )}

                            {/* Actions Bottom Bar */}
                            <div className="pt-2 border-t border-line flex items-center justify-between gap-2 min-h-[44px]">
                              {/* Stage Selector Dropdown */}
                              <select
                                value={app.stage}
                                onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                                className="text-xs font-semibold py-1.5 px-2 rounded-tk-lg border border-line bg-surface text-ink focus:outline-brand-600 cursor-pointer min-h-[36px]"
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
                                  className="p-1.5 text-ink-subtle hover:text-brand-600 transition cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center"
                                  title="Add/Edit Notes"
                                >
                                  <FileText className="w-4 h-4" />
                                </button>

                                {sanitizeExternalUrl(app.applyUrl) && (
                                  <a
                                    href={sanitizeExternalUrl(app.applyUrl)!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-1.5 text-ink-subtle hover:text-brand-600 transition min-h-[36px] min-w-[36px] flex items-center justify-center"
                                    title="Open Official Job Page"
                                  >
                                    <ExternalLink className="w-4 h-4" />
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
            <div className="bg-surface rounded-tk-2xl border border-line overflow-hidden shadow-tk-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-surface-muted border-b border-line text-ink-muted font-semibold uppercase text-xs tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Company & Role</th>
                      <th className="py-3 px-4">Stage</th>
                      <th className="py-3 px-4 hidden sm:table-cell">Location & Salary</th>
                      <th className="py-3 px-4 hidden md:table-cell">Date Applied</th>
                      <th className="py-3 px-4">Notes</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filteredApps.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-ink-subtle">
                          No applications tracked yet. Click "Add Application" to add one.
                        </td>
                      </tr>
                    ) : (
                      filteredApps.map((app) => (
                        <tr key={app.id} className="hover:bg-surface-muted/60 transition-colors">
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-ink">{app.title}</span>
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
                            <div className="text-xs text-ink-muted flex items-center gap-1 mt-0.5">
                              <Building className="w-3 h-3" />
                              <span>{app.company}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <select
                              value={app.stage}
                              onChange={(e) => handleStageSelect(app.id, e.target.value as ApplicationStage)}
                              className="text-xs font-semibold py-1.5 px-2 rounded-tk-lg border border-line bg-surface text-ink cursor-pointer min-h-[36px]"
                            >
                              {KANBAN_STAGES.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-3.5 px-4 hidden sm:table-cell text-xs text-ink-muted">
                            <div>{app.location || "Remote"}</div>
                            {app.salaryText && (
                              <div className="text-success-700 font-medium text-xs">
                                {app.salaryText}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 hidden md:table-cell text-xs text-ink-muted">
                            {app.appliedAt ? new Date(app.appliedAt).toLocaleDateString() : "—"}
                          </td>
                          <td className="py-3.5 px-4">
                            <button
                              type="button"
                              onClick={() => handleOpenNotes(app)}
                              className="text-xs text-ink-muted hover:text-brand-600 flex items-center gap-1 cursor-pointer max-w-[150px] truncate min-h-[36px]"
                            >
                              <FileText className="w-3.5 h-3.5 shrink-0 text-ink-subtle" />
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
                                  className="p-1.5 text-ink-subtle hover:text-brand-600 transition min-h-[36px] min-w-[36px] flex items-center justify-center"
                                  title="Open Link"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDelete(app.id)}
                                className="p-1.5 text-ink-subtle hover:text-danger-600 transition cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center"
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
            <div className="bg-surface rounded-tk-2xl p-8 sm:p-12 text-center border border-line space-y-4 max-w-xl mx-auto shadow-tk-xs">
              <div className="w-12 h-12 rounded-tk-2xl bg-brand-50 text-brand-600 mx-auto flex items-center justify-center shadow-tk-xs">
                <Sparkles className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-ink">Your application pipeline is empty</h3>
                <p className="text-xs sm:text-sm text-ink-muted">
                  Track jobs from the 3D Radar or Job Directory, or click below to manually add an application.
                </p>
              </div>
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-tk-xl bg-brand-600 text-ink-inverse font-bold text-xs shadow-tk-xs hover:bg-brand-700 transition cursor-pointer"
                >
                  Track First Application
                </button>
                <Link
                  href="/jobs"
                  className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-tk-xl border border-line font-bold text-xs text-ink hover:bg-surface-muted transition flex items-center justify-center"
                >
                  Browse Tech Jobs
                </Link>
              </div>
            </div>
          )}
        </main>

        <Footer />
      </div>

      {/* ========================================================================= */}
      {/* MOBILE BOTTOM TAB BAR (<900px)                                            */}
      {/* ========================================================================= */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-surface/95 backdrop-blur-md border-t border-line flex items-center justify-around h-16 px-2">
        <Link
          href="/jobs"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <Briefcase className="w-5 h-5 text-ink-subtle mb-0.5" />
          <span>Jobs</span>
        </Link>

        <Link
          href="/radar"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <Globe className="w-5 h-5 text-ink-subtle mb-0.5" />
          <span>Explore</span>
        </Link>

        <Link
          href="/resume"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <FileText className="w-5 h-5 text-ink-subtle mb-0.5" />
          <span>Resume</span>
        </Link>

        <Link
          href="/applications"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-xs font-bold text-brand-600"
        >
          <CheckSquare className="w-5 h-5 text-brand-600 mb-0.5" />
          <span>Applications</span>
        </Link>

        <Link
          href="/settings?tab=preferences"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <UserIcon className="w-5 h-5 text-ink-subtle mb-0.5" />
          <span>Profile</span>
        </Link>
      </nav>

      {/* MODAL 1: ADD APPLICATION */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-surface rounded-tk-2xl shadow-tk-xl border border-line w-full max-w-md p-6 space-y-5 animate-scaleUp text-ink">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-brand-600" />
                <span>Track Job Application</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="text-ink-subtle hover:text-ink p-1 min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateApplication} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Company Name *</label>
                <input
                  type="text"
                  name="company"
                  value={newCompany}
                  onChange={(e) => {
                    setNewCompany(e.target.value);
                    if (formErrors.company) setFormErrors((prev) => ({ ...prev, company: undefined }));
                  }}
                  placeholder="e.g. Stripe, Airbnb, Datadog"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border transition-colors bg-surface text-ink ${
                    formErrors.company
                      ? "border-danger-500 focus:ring-2 focus:ring-danger-500 focus:outline-none"
                      : "border-line focus:outline-brand-600"
                  }`}
                />
                {formErrors.company && (
                  <p className="text-xs text-danger-600 font-medium mt-1">{formErrors.company}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Job Title *</label>
                <input
                  type="text"
                  name="title"
                  value={newTitle}
                  onChange={(e) => {
                    setNewTitle(e.target.value);
                    if (formErrors.title) setFormErrors((prev) => ({ ...prev, title: undefined }));
                  }}
                  placeholder="e.g. Senior Full-Stack Engineer"
                  className={`w-full text-xs sm:text-sm px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border transition-colors bg-surface text-ink ${
                    formErrors.title
                      ? "border-danger-500 focus:ring-2 focus:ring-danger-500 focus:outline-none"
                      : "border-line focus:outline-brand-600"
                  }`}
                />
                {formErrors.title && (
                  <p className="text-xs text-danger-600 font-medium mt-1">{formErrors.title}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">Location</label>
                  <input
                    type="text"
                    value={newLocation}
                    onChange={(e) => setNewLocation(e.target.value)}
                    placeholder="Remote / City"
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">Salary Band</label>
                  <input
                    type="text"
                    value={newSalary}
                    onChange={(e) => setNewSalary(e.target.value)}
                    placeholder="e.g. $140k - $170k"
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">Initial Stage</label>
                  <select
                    value={newStage}
                    onChange={(e) => setNewStage(e.target.value as ApplicationStage)}
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600 cursor-pointer"
                  >
                    {KANBAN_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">Job Link (URL)</label>
                  <input
                    type="url"
                    value={newApplyUrl}
                    onChange={(e) => setNewApplyUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full text-xs px-3.5 py-2.5 min-h-[44px] rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Recruiter contact, interview round info..."
                  className="w-full text-xs p-3 rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600 resize-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-3 min-h-[44px]">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2.5 min-h-[44px] text-xs font-bold text-ink-muted hover:bg-surface-muted rounded-tk-xl transition-all duration-150 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 min-h-[44px] text-xs font-bold bg-brand-600 text-ink-inverse hover:bg-brand-700 rounded-tk-xl shadow-tk-xs transition-all duration-150 cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 backdrop-blur-xs p-4 animate-fadeIn">
          <div className="bg-surface rounded-tk-2xl shadow-tk-xl border border-line w-full max-w-md p-6 space-y-4 animate-scaleUp text-ink">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h3 className="text-base font-bold text-ink">
                  {activeNotesApp.company} Notes
                </h3>
                <p className="text-xs text-ink-muted">{activeNotesApp.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="text-ink-subtle hover:text-ink p-1 min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-ink-muted">
                Round notes, interviewer names, follow-up dates:
              </label>
              <textarea
                rows={5}
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="e.g. Chat with hiring manager scheduled for Thursday 2pm. Mentioned Go and Kubernetes architecture..."
                className="w-full text-xs sm:text-sm p-3 rounded-tk-xl border border-line bg-surface text-ink focus:outline-brand-600 resize-none"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-3 min-h-[44px]">
              <button
                type="button"
                onClick={() => setActiveNotesApp(null)}
                className="px-4 py-2.5 min-h-[44px] text-xs font-bold text-ink-muted hover:bg-surface-muted rounded-tk-xl"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveNotes}
                className="px-5 py-2.5 min-h-[44px] text-xs font-bold bg-brand-600 text-ink-inverse hover:bg-brand-700 rounded-tk-xl shadow-tk-xs"
              >
                Save Notes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
