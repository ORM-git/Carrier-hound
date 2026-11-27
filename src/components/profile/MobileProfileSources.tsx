"use client";

import React, { useRef, useState } from "react";
import { Linkedin, FileCheck2, Check, Upload } from "lucide-react";
import type { CandidateProfile } from "@/lib/resume/types";
import { createClient } from "@/lib/supabase/client";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";
import { isOnboardingStep2EnabledClient } from "@/config/onboarding";
import { validateResumeUploadFile } from "@/lib/resume/parser";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";

export interface MobileProfileSourcesProps {
  email?: string;
  initialLinkedinUrl?: string;
  candidate: CandidateProfile | null;
  isPro: boolean;
  onProfileConfirmed: (profile: CandidateProfile) => void;
}

/** Phone-only source cards. Desktop profile editing is retained; no LinkedIn scraping. */
export default function MobileProfileSources({ email, initialLinkedinUrl = "", candidate, isPro, onProfileConfirmed }: MobileProfileSourcesProps) {
  const [url, setUrl] = useState(initialLinkedinUrl);
  const [savedUrl, setSavedUrl] = useState(initialLinkedinUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const enabled = isOnboardingStep2EnabledClient();
  const saved = Boolean(savedUrl) && url === savedUrl;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !enabled) return;
    const checked = validateAndNormalizeLinkedInUrl(url);
    if (!checked.valid || !checked.normalizedUrl) { setError(checked.error || "Invalid LinkedIn URL."); return; }
    setSaving(true); setError(null);
    try {
      const { data: { session } } = await createClient().auth.getSession();
      if (!session?.access_token) throw new Error("Your session expired. Please sign in again.");
      const response = await fetch("/api/onboarding/linkedin", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ linkedinUrl: checked.normalizedUrl }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Couldn't save your LinkedIn URL. Please try again.");
      // Saved status follows server acknowledgement only, not a draft or failed request.
      const result = validateAndNormalizeLinkedInUrl(body.linkedinUrl);
      if (!result.valid || !result.normalizedUrl) throw new Error("Couldn't confirm the saved LinkedIn URL. Please reload and try again.");
      setUrl(result.normalizedUrl); setSavedUrl(result.normalizedUrl);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save your LinkedIn URL."); }
    finally { setSaving(false); }
  }

  return <section className="sm:hidden space-y-2" aria-label="Profile sources" data-testid="mobile-profile-sources">
    <h1 className="text-center text-[18px] font-bold text-slate-950">Profile</h1>
    {email && <p className="text-center text-[15px] font-semibold text-slate-950 break-all px-2">{email}</p>}
    <section className="rounded-[20px] bg-white px-4 py-2 text-center" aria-label="LinkedIn profile">
      <div className="mx-auto mb-1 h-[100px] w-[100px] rounded-full bg-[#EAF5FF] flex items-center justify-center"><Linkedin className="h-12 w-12 text-[#2563EB]" aria-hidden="true" /></div>
      <form onSubmit={save} className="space-y-1">
        <div className="relative"><label className="sr-only" htmlFor="profile-linkedin-url">LinkedIn profile URL</label><input id="profile-linkedin-url" value={url} onChange={e => {setUrl(e.target.value); setError(null);}} placeholder="Your LinkedIn profile URL" autoComplete="url" disabled={!enabled || saving} className="w-full min-w-0 h-[44px] rounded-[9px] bg-[#F4F5F7] px-3 pr-9 text-[14px] text-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-60" />{saved && <Check aria-label="Saved LinkedIn URL" className="absolute right-3 top-3 h-5 w-5 text-blue-600" />}</div>
        <button type="submit" disabled={!enabled || saving} className="w-full min-h-[44px] rounded-[9px] bg-[#2563EB] text-white text-[14px] font-semibold disabled:opacity-50">{saving ? "Saving..." : savedUrl ? "Update Your LinkedIn URL" : "Save Your LinkedIn URL"}</button>
        {saved && <p role="status" className="text-xs text-blue-700">LinkedIn URL saved</p>}
        {!enabled && <p className="text-xs text-slate-600">LinkedIn URL saving is not enabled yet. Use a computer to edit your profile details.</p>}
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      </form>
      <button type="button" onClick={()=>setHelp(!help)} aria-expanded={help} className="mt-1 min-h-[44px] text-[14px] text-slate-950 underline underline-offset-4">Get your LinkedIn profile URL</button>
      {help && <p className="text-xs text-slate-600 text-left">Open your personal profile on LinkedIn, copy its link, then paste it here. We save the URL only. We do not import or scrape your LinkedIn profile.</p>}
    </section>
    <section className="rounded-[20px] bg-white px-4 py-2 text-center" aria-label="Resume source">
      <div className="mx-auto mb-1 h-[100px] w-[100px] rounded-full bg-[#EFF6FF] flex items-center justify-center"><FileCheck2 className="h-12 w-12 text-[#2563EB]" aria-hidden="true" /></div>
      <h2 className="text-[15px] font-semibold text-slate-950">{candidate?.confirmedAt ? "Your resume profile is saved" : "Add your resume"}</h2>
      <p className="mt-1 mb-2 text-[13px] leading-[18px] text-slate-800">PDF, Word (.docx) or text files.<br />Files must not exceed 10MB.</p>
      <button type="button" onClick={()=>input.current?.click()} className="w-full min-h-[44px] rounded-[9px] bg-[#2563EB] text-white text-[14px] font-semibold flex items-center justify-center gap-2"><Upload className="w-4 h-4" aria-hidden="true" />Upload Your Resume</button>
      <input ref={input} type="file" accept=".pdf,.docx,.txt" aria-label="Upload profile resume" className="hidden" onChange={event=>{const selected=event.target.files?.[0];event.target.value="";if(!selected)return;const check=validateResumeUploadFile(selected);setFileError(check.valid ? null : check.error || "Invalid resume file.");if(check.valid)setFile(selected);}} />
      {fileError && <p role="alert" className="text-xs text-red-700 mt-2">{fileError}</p>}
      <a href="/resume" className="inline-flex mt-1 min-h-[44px] items-center text-[14px] underline underline-offset-4">Resume tools on computer</a>
    </section>
    {file && <section aria-label="Review uploaded profile resume" className="pt-3"><ResumeUploadAndConfirm key={`${file.name}-${file.lastModified}-${file.size}`} selectedFile={file} reviewOnly isPro={isPro} onProfileConfirmed={profile=>{onProfileConfirmed(profile);setFile(null);}} /></section>}
  </section>;
}
