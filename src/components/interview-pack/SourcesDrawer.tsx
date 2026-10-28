"use client";

import React, { useEffect, useRef } from "react";
import { X, ExternalLink, Database, Calendar } from "lucide-react";
import type { SourceCitation } from "@/data/interviewPackFixture";

interface SourcesDrawerProps {
  open: boolean;
  onClose: () => void;
  sources: SourceCitation[];
}

export default function SourcesDrawer({
  open,
  onClose,
  sources,
}: SourcesDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  // Focus trap and focus return
  useEffect(() => {
    if (open) {
      previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => {
        if (drawerRef.current) {
          const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length > 0) {
            focusable[0].focus();
          }
        }
      }, 50);
      return () => clearTimeout(timer);
    } else {
      if (previouslyFocusedElementRef.current && typeof previouslyFocusedElementRef.current.focus === "function") {
        previouslyFocusedElementRef.current.focus();
      }
    }
  }, [open]);

  // Keyboard navigation: Escape to close, Tab focus trapping
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        const focusables = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));

        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sources-drawer-title"
      className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10" ref={drawerRef}>
        <div className="w-screen max-w-md bg-white shadow-2xl flex flex-col">
          {/* Header */}
          <div className="p-6 border-b border-[#E2E8F0] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-[#2563EB]" />
              <h2 id="sources-drawer-title" className="text-lg font-bold text-[#0F172A]">
                Sources & Public Evidence
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sources drawer"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Subtitle notice */}
          <div className="p-4 bg-slate-50 border-b border-[#E2E8F0] text-[15px] text-[#475569] leading-relaxed">
            Every predicted question and benchmark in this dossier is cited directly from indexed public submissions, developer discussions, and published engineering handbooks.
          </div>

          {/* Content list */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {sources.map((src, idx) => (
              <div
                key={idx}
                className="p-4 rounded-xl border border-[#E2E8F0] hover:border-[#93C5FD] transition space-y-2 bg-white"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-[#1D4ED8] bg-[#EFF6FF] px-2.5 py-0.5 rounded-full border border-[#BFDBFE]">
                    {src.verificationType}
                  </span>
                  <div className="flex items-center gap-1 text-[13px] text-slate-400">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{src.date}</span>
                  </div>
                </div>

                <h3 className="text-[15px] font-bold text-[#0F172A] leading-snug">
                  {src.title}
                </h3>

                <div className="flex items-center justify-between pt-1 text-[13px]">
                  <span className="font-semibold text-slate-500">{src.domain}</span>
                  {src.url && src.url !== "#" ? (
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Inspect source for ${src.title}`}
                      className="font-bold text-[#2563EB] hover:underline inline-flex items-center gap-1"
                    >
                      <span>Inspect source</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-slate-400 font-medium">Public Submission Archive</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Footer note */}
          <div className="p-4 border-t border-[#E2E8F0] bg-slate-50 text-[13px] text-slate-500 text-center">
            Preparation aid based on public sources; no hiring outcome is guaranteed.
          </div>
        </div>
      </div>
    </div>
  );
}
