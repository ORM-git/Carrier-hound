"use client";

import React from "react";
import Link from "next/link";
import BrandIcon from "./BrandIcon";
import Chip from "./Chip";
import { Job } from "@/data/jobs";
import { ArrowRight } from "lucide-react";
import { sanitizeExternalUrl } from "@/lib/security/xss";

interface JobPreviewProps {
  title?: string;
  subtitle?: string;
  jobs: Job[];
  limit?: number;
}

export default function JobPreview({
  title = "Direct Employer ATS Feed",
  subtitle = "Real-time crawler stream across verified company subdomains",
  jobs,
  limit = 5,
}: JobPreviewProps) {
  const displayJobs = jobs.slice(0, limit);

  return (
    <div className="w-full my-8 rounded-[12px] border border-[#DBE3EF] overflow-hidden bg-white shadow-sm">
      {/* Header row: blue-tint bg #F8FAFF */}
      <div className="bg-[#F8FAFF] px-5 sm:px-6 py-4 border-b border-[#DBE3EF] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-[#2563EB]">
            <BrandIcon className="w-4 h-4 text-[#2563EB]" />
          </div>
          <div>
            <h4 className="text-base font-bold text-[#09090B] leading-tight">{title}</h4>
            <p className="text-xs text-[#4B5563]">{subtitle}</p>
          </div>
        </div>

        {/* Right side: green status dot + timestamp */}
        <div className="flex items-center gap-2 text-xs text-gray-500 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Feed snapshot • Just now UTC</span>
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-[#DBE3EF]">
        {displayJobs.map((job) => (
          <div
            key={job.id}
            className="p-5 sm:p-6 hover:bg-slate-50/70 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            <div className="space-y-2">
              <h5 className="text-lg font-bold text-[#09090B] hover:text-[#2563EB] transition-colors cursor-pointer">
                {job.title}
              </h5>
              <div className="text-sm text-[#4B5563]">
                <span className="font-medium text-gray-700">{job.company}</span> • {job.location} •{" "}
                <span className="text-blue-700">Remote eligibility applies</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* Green salary chip */}
                <Chip variant="salary">{job.salary}</Chip>
                {/* Gray direct company source chip */}
                <Chip variant="source">Direct company source</Chip>
                {job.remote && <Chip variant="default">100% Remote</Chip>}
              </div>
            </div>

            {/* Right side */}
            <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-3 pt-2 sm:pt-0">
              <span className="text-xs text-[#4B5563] whitespace-nowrap">
                First seen {job.date}
              </span>
              <a
                href={sanitizeExternalUrl(job.applyUrl) || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#2563EB] hover:bg-blue-700 text-white text-sm font-semibold transition-colors whitespace-nowrap group shadow-xs"
              >
                <span>Apply Direct</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
