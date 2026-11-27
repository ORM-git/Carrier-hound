"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Heart, MoreHorizontal } from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import JobCardContent from "@/components/jobs/JobCardContent";
import type { LiveJob } from "@/lib/jobs/service";

// Static display examples grounded in the owner's Nov25 screenshot. Not live job inventory.
export const LANDING_PREVIEW_JOBS: LiveJob[] = [
  { id: "landing-planetscale", company: "PlanetScale", title: "Video Production Lead", category: "Engineering", remote: true, remoteScope: "us", country: "US", location: "Remote US", logoUrl: "/landing-companies/planetscale.svg", salary: "", type: "", date: "", directSource: false, skills: [], description: "", applyUrl: "" },
  { id: "landing-docker", company: "Docker", title: "Senior Principal Forward Deployed Engineer", category: "Engineering", remote: true, remoteScope: "us", country: "US", location: "United States", logoUrl: "/landing-companies/docker.svg", salary: "", type: "", date: "", directSource: false, skills: [], description: "", applyUrl: "" },
];
const noop = () => {};
function PreviewActions() {
  return <div className="flex w-full sm:w-auto items-center justify-end gap-1.5">
    <Link href="/jobs" aria-label="Browse job options" className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-[#475569]"><MoreHorizontal className="w-4 h-4" /></Link>
    <Link href="/jobs" aria-label="Open Jobs to save roles" className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569]"><Heart className="w-4 h-4" /></Link>
    <Link href="/jobs" className="inline-flex min-w-[132px] sm:min-w-0 justify-center items-center gap-1.5 px-6 sm:px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] text-white text-xs font-bold"><span className="sm:hidden">Apply</span><span className="hidden sm:inline">Browse jobs</span><ArrowRight className="w-3.5 h-3.5" /></Link>
  </div>;
}

/** Same visual renderer as Jobs. No API calls, user data, personal percentages or live vacancy claim. */
export default function LandingJobsPreview() {
  const [scores, setScores] = useState([0, 0]);
  useEffect(() => {
    const targets = [90, 95]; // Owner-selected illustrative preview values, not a visitor's fit.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setScores(targets);
      return;
    }
    // Let the zero-length arc paint, then the shared ring's stroke transition fills it.
    const timer = window.setTimeout(() => setScores(targets), 80);
    return () => window.clearTimeout(timer);
  }, []);
  return <section className="landing-actual-preview" aria-labelledby="landing-preview-heading">
    <p id="landing-preview-heading" className="preview-heading hidden sm:block">Preview of the Jobs experience · sample scores</p>
    <div className="space-y-3">
      {LANDING_PREVIEW_JOBS.map((job, index) => <div key={job.id} className={index === 1 ? "peek" : undefined} aria-hidden={index === 1 || undefined} ref={node => { if (node && index === 1) node.setAttribute("inert", ""); }}><article data-testid="landing-job-card" className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none min-h-fit">
        <JobCardContent job={job} index={index} isPro isSaved={false} matchScore={scores[index]} scoreDescription={`Preview score: ${scores[index]}%, not your personal match`} mobilePreviewCompany={index === 0 ? "Microsoft" : undefined} mobilePreviewTitle={index === 0 ? "Software Engineer" : undefined} mobilePreviewLogo={index === 0 ? <CompanyLogo company="Microsoft" logoUrl="/company-logos-static/microsoft.png" className="w-8 h-8 rounded-lg shrink-0 object-contain p-0.5 border border-[#E2E8F0] bg-white" /> : undefined} cardZeroSkills={false} isRecent={false} postedRelative={null} companyPills={["Engineering"]} locInfo={{ primary: job.location, extraCount: 0, all: [job.location] }} jobLevel="Staff / Lead" formattedJobType={null} getTagColorClass={() => "bg-blue-50 text-blue-700 border-blue-200"} formatRelativeTime={() => ""} handleHideJob={noop} handleToggleApplied={noop} handleSaveJob={noop} handleSelectJob={noop} handleLockedAction={noop} footerText={<span className="hidden sm:inline">Jobs preview</span>} footerActions={<PreviewActions />} />
      </article></div>)}
    </div>
  </section>;
}
