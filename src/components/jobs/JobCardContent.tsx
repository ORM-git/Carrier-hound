"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, Briefcase, Clock, DollarSign, EyeOff, Heart, Laptop, Lock, MapPin, Sparkles, TrendingUp } from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { JobCardMenu } from "@/components/jobs/JobCardMenu";
import type { LiveJob } from "@/lib/jobs/service";
import { workModelLabel, isDuplicateWorkModelLocation } from "@/lib/jobs/workModel";

export interface JobCardContentProps {
  /** Optional landing preview slots. Default Jobs presentation/actions are unchanged. */
  scoreDescription?: string;
  /** Owner-selected landing-only phone artwork/title overrides. Jobs data stays unchanged. */
  mobilePreviewLogo?: React.ReactNode;
  mobilePreviewTitle?: string;
  mobilePreviewCompany?: string;
  footerText?: React.ReactNode;
  footerActions?: React.ReactNode;
  job: LiveJob;
  index: number;
  isPro: boolean;
  /** Signed-in users (Free or Pro) see the job location; guests keep the lock. Defaults to isPro. */
  locationVisible?: boolean;
  isSaved: boolean;
  matchScore: number | null;
  cardZeroSkills: boolean;
  isRecent: boolean;
  postedRelative: string | null;
  companyPills: string[];
  locInfo: { primary: string; extraCount: number; all: string[] };
  jobLevel: string;
  formattedJobType: string | null;
  getTagColorClass: (text: string) => string;
  formatRelativeTime: (date?: string) => string;
  handleHideJob: (event: React.MouseEvent, id: string) => void;
  handleToggleApplied: (job: LiveJob) => void;
  handleSaveJob: (job: LiveJob) => void;
  handleSelectJob: (job: LiveJob) => void;
  handleLockedAction: (event: React.MouseEvent<HTMLElement>) => void;
  /** Pro list only: called when this card's company logo has nothing left to show (none or all failed). */
  onLogoUnresolved?: () => void;
}

/**
 * When CareerMonke first saw this job (its arrival), or null. Only firstSeenAt counts: never postedAt, date or
 * created_at, which mix employer posting time with fallbacks. Unparseable or future (beyond 5 min clock skew) is null.
 */
export function cmArrivalAt(job: { firstSeenAt?: unknown } | null | undefined, now: number = Date.now()): string | null {
  const raw = job?.firstSeenAt;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now + 5 * 60_000) return null;
  return new Date(t).toISOString();
}

/** Unchanged Jobs desktop/mobile presentation. Caller owns data, entitlement, scores and actions. */
export default function JobCardContent({ job, index, isPro, locationVisible, isSaved, matchScore, cardZeroSkills, isRecent, postedRelative, companyPills, locInfo, jobLevel, formattedJobType, getTagColorClass, formatRelativeTime, handleHideJob, handleToggleApplied, handleSaveJob, handleSelectJob, handleLockedAction, footerText, footerActions, scoreDescription, mobilePreviewLogo, mobilePreviewTitle, mobilePreviewCompany, onLogoUnresolved }: JobCardContentProps) {
  const mode = workModelLabel(job);
  const canSeeLocation = locationVisible ?? isPro;
  const showLocation = !canSeeLocation || !isDuplicateWorkModelLocation(locInfo.primary, mode, locInfo.extraCount);
  const arrivalAt = cmArrivalAt(job);
  return <>
                            {/* DESKTOP VIEW (sm and up: 768px, 1024px, 1440px) */}
                            <div className="hidden sm:flex items-stretch justify-between gap-4 flex-1 min-h-[196px] w-full">
                              {/* Left & Middle: 72x72 Logo, Header, Dividers, Aligned 2x3 Grid, and Footer Actions */}
                              <div className="flex-1 min-w-0 flex flex-col justify-between gap-2.5">
                                {/* Top area: Logo left, Header with tags & options menu */}
                                <div className="flex items-start gap-4 min-w-0">
                                  {/* 72px company logo square, radius 8, minimal padding */}
                                  <CompanyLogo
                                    company={job.company}
                                    locked={!isPro}
                                    maskSeed={job.id}
                                    applyUrl={job.applyUrl}
                                    logoUrl={job.logoUrl}
                                    companyLogoUrl={job.companyLogoUrl}
                                    onUnresolved={isPro ? onLogoUnresolved : undefined}
                                    domain={job.companyDomain}
                                    className="w-[56px] h-[56px] sm:w-[72px] sm:h-[72px] rounded-lg shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
                                  />

                                  <div className="min-w-0 flex-1 space-y-1">
                                    {/* Top row: small colored pill tags (posted time & early applicant) left aligned, options menu at right */}
                                    <div className="flex items-center justify-between gap-2 min-h-[22px]">
                                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                        {job.postedAt && postedRelative ? (
                                          <span
                                            data-testid="job-card-posted-tag"
                                            className="h-[22px] px-2 py-0.5 rounded text-[11px] font-medium bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE] inline-flex items-center gap-1"
                                          >
                                            <Clock className="w-3 h-3 text-[#2563EB] shrink-0" />
                                            <span>{postedRelative}</span>
                                          </span>
                                        ) : null}
                                        {isRecent ? (
                                          <span
                                            data-testid="job-card-early-tag"
                                            className="h-[22px] px-2 py-0.5 rounded text-[11px] font-medium bg-[#EFF6FF] text-[#1E40AF] border border-[#93C5FD] shadow-[0_0_0_1px_rgba(37,99,235,0.18),0_1px_9px_rgba(37,99,235,0.42)] inline-flex items-center"
                                          >
                                            Early applicant
                                          </span>
                                        ) : null}
                                        {job.remote && (
                                          <span className="h-[22px] px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-[#475569] inline-flex items-center">
                                            Remote Eligible
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {/* Title: 20px / 600 / 24px line-height with ellipsis */}
                                    <h2 className="text-[20px] font-semibold text-[#0F172A] leading-[24px] truncate my-0" title={job.title}>
                                      {job.title}
                                    </h2>

                                    {/* Company and category/type pills */}
                                    <div className="flex items-center gap-1.5 text-[13px] text-[#475569] min-w-0 flex-wrap h-5">
                                      <span className={`inline-flex items-center h-5 leading-none ${!isPro ? "filter blur-[4px] select-none font-medium text-[#334155]" : "font-medium text-[#334155]"}`}>
                                        {(isPro && job.company) || "Verified Employer"}
                                      </span>
                                      {companyPills.length > 0 && (
                                        <div className="inline-flex items-center gap-1.5 min-w-0" data-testid="job-card-category-pills">
                                          {companyPills.map((pill) => (
                                            <span
                                              key={pill}
                                              className={`inline-flex items-center h-5 px-1.5 py-0.5 rounded text-[11px] font-medium border leading-none ${getTagColorClass(pill)}`}
                                            >
                                              {pill}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Role, tags and metadata remain one uninterrupted group. */}

                                {/* Aligned 2-row × 3-column metadata grid, 16px SVG icons, 4px gap, 13px text */}
                                <div className="grid grid-cols-3 grid-rows-2 gap-x-4 gap-y-2 text-[13px] font-semibold text-[#1E293B]">
                                  {/* Row 1, Col 1: Location */}
                                  {showLocation && <div className="flex items-center gap-1.5 min-w-0 truncate h-5">
                                    <MapPin className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className="truncate" title={canSeeLocation ? (locInfo.primary || "Location unlisted") : undefined}>
                                      {canSeeLocation ? (locInfo.primary || "Location unlisted") : <span className="text-[#64748B]">Location locked</span>}
                                    </span>
                                    {canSeeLocation && locInfo.extraCount > 0 && (
                                      <span
                                        className="text-[11px] font-bold text-blue-600 bg-blue-50 px-1 py-0.5 rounded shrink-0 cursor-help leading-none"
                                        title={locInfo.all.join(", ")}
                                        aria-label={`${locInfo.extraCount} additional locations`}
                                      >
                                        +{locInfo.extraCount}
                                      </span>
                                    )}
                                  </div>}

                                  {/* Row 1, Col 2: Job type */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate h-5">
                                    {formattedJobType ? (
                                      <>
                                        <Briefcase className="w-4 h-4 text-[#475569] shrink-0" />
                                        <span className="truncate">{formattedJobType}</span>
                                      </>
                                    ) : null}
                                  </div>

                                  {/* Row 1, Col 3: Salary (highlighted with stronger weight) */}
                                  <div
                                    className="flex items-center gap-1.5 min-w-0 truncate h-5"
                                    title={isPro && job.salary_original && job.salary_original !== job.salary ? `Original: ${job.salary_original}` : undefined}
                                  >
                                    <DollarSign className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className={`truncate ${job.salary ? "font-semibold text-[#0F172A]" : ""}`}>
                                      {job.salary ? (isPro ? job.salary : "••••••••") : "Salary unlisted"}
                                    </span>
                                    {isPro && job.salary_original && job.salary_original !== job.salary && (
                                      <span className="text-[11px] text-[#64748B] truncate hidden sm:inline">
                                        ({job.salary_original})
                                      </span>
                                    )}
                                  </div>

                                  {/* Row 2, Col 1: Work mode */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate h-5">
                                    <Laptop className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className="truncate">{mode}</span>
                                  </div>

                                  {/* Row 2, Col 2: Seniority level */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate h-5">
                                    {jobLevel ? (
                                      <>
                                        <TrendingUp className="w-4 h-4 text-[#475569] shrink-0" />
                                        <span className="truncate">{jobLevel}</span>
                                      </>
                                    ) : null}
                                  </div>

                                  {/* Row 2, Col 3: Empty cell */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate h-5" />
                                </div>

                                {/* Horizontal divider 2: thin 1px light gray line */}
                                <div className="border-b border-[#E2E8F0]" />

                                {/* Footer with action buttons (Hide, Save, Apply) */}
                                {footerActions || <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleHideJob(e, job.id);
                                    }}
                                    aria-label="Hide position"
                                    title="Hide position"
                                    className="w-8 h-8 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                                  >
                                    <EyeOff className="w-4 h-4" />
                                  </button>

                                      <JobCardMenu
                                        job={job}
                                        locked={!isPro}
                                        onRemoveFromList={() => handleHideJob({ stopPropagation: () => {} } as any, job.id)}
                                        onAlreadyApplied={() => handleToggleApplied(job)}
                                      />
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSaveJob(job);
                                    }}
                                    aria-label={isSaved ? "Unlike job" : "Save job"}
                                    title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
                                    className={`w-8 h-8 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                                      isSaved
                                        ? "border-rose-200 bg-rose-50 text-rose-600"
                                        : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                                    }`}
                                  >
                                    <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
                                  </button>

                                  {isPro ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSelectJob(job);
                                      }}
                                      data-tour={index === 0 ? "tour-job-apply" : undefined}
                                      className="w-[120px] h-8 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
                                    >
                                      <span>Apply</span>
                                      <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleLockedAction(e);
                                      }}
                                      data-tour={index === 0 ? "tour-job-apply" : undefined}
                                      className="w-[120px] h-8 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
                                    >
                                      <Lock className="w-3.5 h-3.5" />
                                      <span>Apply</span>
                                    </button>
                                  )}
                                </div>}
                              </div>

                              {/* Right: Desktop Match Panel (about 164px wide, inset 4px top/right/bottom, radius 12, full card height ~224px) */}
                              {matchScore !== null ? (
                                <div className="w-[164px] sm:w-44 shrink-0 rounded-xl sm:rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] text-white border border-emerald-950/40 p-3 self-stretch my-0.5 mr-0.5 flex flex-col items-center justify-between min-h-[196px] text-center shadow-inner">
                                  <div className="flex flex-col items-center w-full pt-1">
                                    {/* Same white capsule with a CM-blue perimeter on every breakpoint (reference). */}
                                    <CircularMatchRing
                                      score={matchScore}
                                      size={70}
                                      strokeWidth={3}
                                      light
                                      isPro={isPro}
                                    />
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-100 mt-2">
                                      {scoreDescription ? "PREVIEW SCORE" : cardZeroSkills
                                        ? "EXPERIENCE MATCH"
                                        : matchScore !== null && matchScore >= 80
                                        ? "STRONG MATCH"
                                        : matchScore !== null && matchScore >= 60
                                        ? "GOOD MATCH"
                                        : "FAIR MATCH"}
                                    </div>
                                  </div>

                                  <div className="w-full pt-2 border-t border-white/10 mt-2">
                                    <div className="space-y-1 text-[11px] text-slate-300 text-left w-full pl-2">
                                      <div className="flex items-center gap-1.5 text-slate-300">
                                        <span className="text-emerald-400 font-bold">✓</span>
                                        <span className="truncate">{job.remote ? "Remote Eligible" : "Verified Direct"}</span>
                                      </div>
                                      <div className="flex items-center gap-1.5 text-slate-300">
                                        <span className="text-emerald-400 font-bold">✓</span>
                                        <span className="truncate">{scoreDescription ? "Sample score" : (job.directSource ? "Direct Feed" : "Active Feed")}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <Link
                                  href="/resume"
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-[164px] sm:w-44 shrink-0 rounded-xl sm:rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] border border-emerald-950/40 text-center p-3 transition-all duration-200 group/cta space-y-2.5 self-stretch my-0.5 mr-0.5 focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 text-white min-h-[196px] flex flex-col items-center justify-between"
                                >
                                  <div className="flex flex-col items-center justify-center flex-1 w-full space-y-2">
                                    <div className="w-11 h-11 rounded-full bg-blue-500/10 border border-blue-400/30 flex items-center justify-center transition-colors">
                                      <Sparkles className="w-5 h-5 text-blue-400" />
                                    </div>
                                    <span className="text-xs font-bold text-white uppercase tracking-wider">
                                      Match Score
                                    </span>
                                    <span className="text-[11px] text-slate-300 group-hover/cta:text-blue-300 transition-colors leading-tight px-1">
                                      Upload your resume to see your real match
                                    </span>
                                  </div>
                                </Link>
                              )}
                            </div>

                            {/* MOBILE VIEW (under sm: 390px, 360px) */}
                            <div data-testid="mobile-reference-card" className="flex sm:hidden flex-col justify-between w-full space-y-3">
                              {/* Top row: company and 52px match ring; menu sits beside the heart below. */}
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                  {mobilePreviewLogo || <CompanyLogo
                                    company={job.company}
                                    locked={!isPro}
                                    maskSeed={job.id}
                                    maskedPalette="job-list-preview"
                                    applyUrl={job.applyUrl}
                                    logoUrl={job.logoUrl}
                                    companyLogoUrl={job.companyLogoUrl}
                                    onUnresolved={isPro ? onLogoUnresolved : undefined}
                                    domain={job.companyDomain}
                                    className="w-8 h-8 rounded-lg shrink-0 object-contain p-0.5 border border-[#E2E8F0] bg-white"
                                  />}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 text-[14px] text-[#475569] truncate h-5">
                                      <span className={`inline-flex items-center h-5 leading-none ${!isPro ? "filter blur-[4px] select-none font-semibold text-[#0F172A]" : "font-semibold text-[#0F172A]"}`}>
                                        {(isPro && (mobilePreviewCompany || job.company)) || "Verified Employer"}
                                      </span>
                                    </div>
                                    {job.category ? (
                                      <div className="text-xs text-[#475569] truncate mt-0.5">
                                        {job.category && <span className="capitalize">{job.category}</span>}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Compact match badge at top right */}
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {matchScore !== null ? (
                                    <div
                                      data-testid="mobile-card-score"
                                      className="flex"
                                      role="img"
                                      title={scoreDescription || `Fit Match: ${matchScore}%`}
                                      aria-label={scoreDescription || `Fit Match: ${matchScore}%`}
                                    >
                                      <CircularMatchRing score={matchScore} size={56} strokeWidth={2.4} light />
                                    </div>
                                  ) : (
                                    <Link
                                      href="/resume"
                                      onClick={(e) => e.stopPropagation()}
                                      className="h-[30px] px-2.5 rounded-full border border-blue-500/30 bg-blue-500/10 flex items-center justify-center text-[11px] font-bold text-blue-600 hover:bg-blue-500/20 transition"
                                      title="Fit Match: Upload resume"
                                    >
                                      +Score
                                    </Link>
                                  )}


                                </div>
                              </div>

                              {/* Title: 16px/700 below the top row */}
                              <h2 className="text-[16px] font-bold text-[#0F172A] leading-snug line-clamp-2 mt-1">
                                {mobilePreviewTitle || job.title}
                              </h2>

                              {/* Title and metadata remain one uninterrupted group. */}

                              {/* Small wrapping metadata chips beneath title: roughly 24px high, 12px text (posted time not duplicated here) */}
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                {showLocation && <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#1E293B] text-[12px] font-semibold inline-flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-[#475569]" />
                                  {canSeeLocation ? (locInfo.primary || "Location unlisted") : <span className="text-[#64748B]">Location locked</span>}
                                  {canSeeLocation && locInfo.extraCount > 0 && <span>(+{locInfo.extraCount})</span>}
                                </span>}
                                {formattedJobType && (
                                  <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#1E293B] text-[12px] font-semibold inline-flex items-center gap-1">
                                    <Briefcase className="w-3 h-3 text-[#475569]" />
                                    {formattedJobType}
                                  </span>
                                )}
                                {/* Work model always shown, from remoteScope (Remote / Hybrid / On-site / Flexible) */}
                                <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#1E293B] text-[12px] font-semibold inline-flex items-center gap-1">
                                  <Laptop className="w-3 h-3 text-[#475569]" />
                                  {mode}
                                </span>
                                {jobLevel && (
                                  <span data-testid="mobile-card-level" className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#1E293B] text-[12px] font-semibold inline-flex items-center gap-1">
                                    <TrendingUp className="w-3 h-3 text-[#475569]" />
                                    {jobLevel}
                                  </span>
                                )}
                                {isRecent && (
                                  <span data-mobile-early="true" className="h-6 px-2.5 py-0.5 rounded-md text-[12px] font-semibold bg-[#EFF6FF] text-[#1E40AF] shadow-[0_0_0_1px_rgba(37,99,235,0.18),0_1px_9px_rgba(37,99,235,0.42)] inline-flex items-center">
                                    Early applicant
                                  </span>
                                )}
                                {job.salary && (
                                  <span
                                    className="min-h-6 h-auto max-w-full flex-wrap whitespace-normal break-words px-2.5 py-1 rounded-md bg-[#F1F5F9] text-[#1E293B] text-[12px] font-semibold inline-flex items-center gap-1"
                                    title={isPro && job.salary_original && job.salary_original !== job.salary ? `Original: ${job.salary_original}` : undefined}
                                  >
                                    <DollarSign className="w-3 h-3 text-[#475569]" />
                                    {isPro ? job.salary : "••••••••"}
                                    {/* Original-currency value visible on touch, not only in a hover title */}
                                    {isPro && job.salary_original && job.salary_original !== job.salary && (
                                      <span className="font-normal text-[#64748B]">({job.salary_original})</span>
                                    )}
                                  </span>
                                )}
                              </div>

                              {/* Footer divider, posted time on left, existing actions on right with 44px targets */}
                              <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0] mt-1">
                                {/* CM arrival age (first_seen_at) only: nothing when unknown, never the employer posting time */}
                                <span data-testid="cm-arrival-age" className="text-xs text-[#475569] truncate">
                                  {footerText || (arrivalAt ? formatRelativeTime(arrivalAt) : null)}
                                </span>

                                {/* Hide lives in the card menu (Remove From List); no standalone ban icon on mobile */}
                                {footerActions || <div className="flex items-center gap-1.5">
                                  <JobCardMenu
                                    job={job}
                                    locked={!isPro}
                                    onRemoveFromList={() => handleHideJob({ stopPropagation: () => {} } as any, job.id)}
                                    onAlreadyApplied={() => handleToggleApplied(job)}
                                  />
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSaveJob(job);
                                    }}
                                    aria-label={isSaved ? "Unlike job" : "Save job"}
                                    className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
                                      isSaved
                                        ? "border-rose-200 bg-rose-50 text-rose-600"
                                        : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                                    }`}
                                  >
                                    <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
                                  </button>

                                  {isPro ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSelectJob(job);
                                      }}
                                      data-mobile-list-apply="true"
                                      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition cursor-pointer"
                                    >
                                      <span>Apply</span>
                                      <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleLockedAction(e);
                                      }}
                                      data-mobile-list-apply="true"
                                      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition cursor-pointer"
                                    >
                                      <Lock className="w-3.5 h-3.5" />
                                      <span>Apply</span>
                                    </button>
                                  )}
                                </div>}
                              </div>
                            </div>
  </>;
}

function CircularMatchRing({
  score,
  size = 56,
  strokeWidth = 4.5,
  light = false,
  shape = "capsule",
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  isPro?: boolean; // accepted for call-site compatibility; not rendered
  /** White-card variant (mobile list): CM-blue arc on a pale track, dark text. */
  light?: boolean;
  /** Desktop ring (pre-#726): full circle; the mobile reference stays a capsule. */
  shape?: "capsule" | "circle";
}) {
  const displayScore = Math.min(100, Math.max(0, score));
  const textClass = size >= 75 ? "text-2xl font-black" : size >= 65 ? "text-xl font-black" : size >= 50 ? "text-[16px] font-bold" : "text-[13px] font-bold";

  const capsuleTextClass = size >= 65 ? "text-[21px] font-extrabold" : "text-[17px] font-extrabold";

  if (shape === "circle") {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (displayScore / 100) * circumference;
    return (
      <div
        className="relative inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        <svg aria-hidden="true" className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={light ? "#DBEAFE" : "#1E293B"}
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={light ? "#2563EB" : "#2DD4BF"}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-300 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`${textClass} ${light ? "text-[#0F172A]" : "text-white"} leading-none tracking-tight`}>
            {displayScore}<span className="text-[0.6em] font-semibold ml-px">%</span>
          </span>
        </div>
      </div>
    );
  }

  // Reference is a capsule: straight top/bottom, semicircular ends, not an ellipse.
  // The arc starts where the bottom edge meets the right end, runs clockwise (left along the bottom, up the
  // left end, right along the top) and the unfilled remainder is the pale track on the lower right.
  const height = Math.round(size * (58 / 104));
  const radius = (height - strokeWidth) / 2;
  const inset = strokeWidth / 2;
  const left = height / 2;
  const right = size - left;
  const outline = `M ${right} ${height - inset} H ${left} A ${radius} ${radius} 0 0 1 ${left} ${inset} H ${right} A ${radius} ${radius} 0 0 1 ${right} ${height - inset}`;
  const offset = 100 - displayScore;

  return (
    <div
      className="relative inline-flex items-center justify-center shrink-0 rounded-full bg-white"
      style={{ width: size, height }}
    >
      <svg aria-hidden="true" className="w-full h-full" viewBox={`0 0 ${size} ${height}`}>
        <path
          d={outline}
          stroke={light ? "#E2E8F0" : "#1E293B"}
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        {displayScore > 0 && (
        <path
          d={outline}
          stroke={light ? "#2563EB" : "#2DD4BF"}
          strokeWidth={strokeWidth}
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-300 ease-out"
        />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`${capsuleTextClass} ${light ? "text-[#0B1220]" : "text-white"} leading-none tracking-tight`}>
          {displayScore}<span className="text-[0.62em] font-bold ml-px">%</span>
        </span>
      </div>
    </div>
  );
}
