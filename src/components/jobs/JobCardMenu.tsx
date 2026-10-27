"use client";

import React, { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Ban, CheckCircle2, Share2, Flag } from "lucide-react";
import { toast } from "react-toastify";
import type { LiveJob } from "@/lib/jobs/service";
import { getCanonicalJobUrl, getReportJobMailto } from "@/components/jobs/JobDetailView";

export interface JobCardMenuProps {
  job: LiveJob;
  onRemoveFromList: () => void;
  onAlreadyApplied: () => void;
  className?: string;
}

export function JobCardMenu({
  job,
  onRemoveFromList,
  onAlreadyApplied,
  className = "",
}: JobCardMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const wasOpenRef = useRef(false);

  // Focus management: move focus into menu on open, back to trigger on close
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      setFocusedIndex(0);
      requestAnimationFrame(() => {
        itemRefs.current[0]?.focus();
      });
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((prev) => {
        const next = (prev + 1) % 4;
        itemRefs.current[next]?.focus();
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex((prev) => {
        const next = (prev - 1 + 4) % 4;
        itemRefs.current[next]?.focus();
        return next;
      });
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(0);
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(3);
      itemRefs.current[3]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(false);
    }
  };

  const handleShare = async () => {
    const url = getCanonicalJobUrl(job.id);
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: job.title,
          text: `${job.title} at ${job.company || "Company"}`,
          url,
        });
        toast.success("Job link shared!");
        setIsOpen(false);
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") {
          setIsOpen(false);
          return;
        }
      }
    }

    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Job link copied to clipboard!");
      } catch {
        toast.error("Failed to copy link");
      }
    } else {
      toast.info(`Job link: ${url}`);
    }
    setIsOpen(false);
  };

  const handleReportIssue = () => {
    const mailto = getReportJobMailto(job);
    window.location.href = mailto;
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className={`relative inline-block text-left ${className}`}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="job-card-menu-button"
        aria-label="More options for this job"
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className="w-11 h-11 sm:w-8 sm:h-8 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center rounded-full text-[#64748B] hover:text-[#0F172A] hover:bg-[#F1F5F9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] transition cursor-pointer"
      >
        <MoreHorizontal className="w-5 h-5 sm:w-4 sm:h-4" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-orientation="vertical"
          aria-label="Job options"
          data-testid="job-card-menu-popover"
          className="absolute right-0 top-full mt-1.5 w-48 bg-white rounded-[12px] shadow-lg border border-[#E2E8F0] p-1.5 z-50 text-left animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Row 1: Remove From List */}
          <button
            ref={(el) => { itemRefs.current[0] = el; }}
            role="menuitem"
            tabIndex={focusedIndex === 0 ? 0 : -1}
            data-testid="job-card-menu-item-remove"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
              onRemoveFromList();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-[#1E293B] hover:bg-[#F1F5F9] hover:text-[#0F172A] rounded-lg transition text-left cursor-pointer focus:bg-[#F1F5F9] focus:outline-none"
          >
            <Ban className="w-4 h-4 text-[#64748B] shrink-0" />
            <span>Remove From List</span>
          </button>

          {/* Row 2: Already Applied */}
          <button
            ref={(el) => { itemRefs.current[1] = el; }}
            role="menuitem"
            tabIndex={focusedIndex === 1 ? 0 : -1}
            data-testid="job-card-menu-item-applied"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
              onAlreadyApplied();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-[#1E293B] hover:bg-[#F1F5F9] hover:text-[#0F172A] rounded-lg transition text-left cursor-pointer focus:bg-[#F1F5F9] focus:outline-none"
          >
            <CheckCircle2 className="w-4 h-4 text-[#64748B] shrink-0" />
            <span>Already Applied</span>
          </button>

          {/* Row 3: Share */}
          <button
            ref={(el) => { itemRefs.current[2] = el; }}
            role="menuitem"
            tabIndex={focusedIndex === 2 ? 0 : -1}
            data-testid="job-card-menu-item-share"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleShare();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-[#1E293B] hover:bg-[#F1F5F9] hover:text-[#0F172A] rounded-lg transition text-left cursor-pointer focus:bg-[#F1F5F9] focus:outline-none"
          >
            <Share2 className="w-4 h-4 text-[#64748B] shrink-0" />
            <span>Share</span>
          </button>

          {/* Row 4: Report Issue */}
          <button
            ref={(el) => { itemRefs.current[3] = el; }}
            role="menuitem"
            tabIndex={focusedIndex === 3 ? 0 : -1}
            data-testid="job-card-menu-item-report"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleReportIssue();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-[#1E293B] hover:bg-[#F1F5F9] hover:text-[#0F172A] rounded-lg transition text-left cursor-pointer focus:bg-[#F1F5F9] focus:outline-none"
          >
            <Flag className="w-4 h-4 text-[#64748B] shrink-0" />
            <span>Report Issue</span>
          </button>
        </div>
      )}
    </div>
  );
}
