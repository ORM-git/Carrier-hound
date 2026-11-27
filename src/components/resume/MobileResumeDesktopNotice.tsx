import React from "react";
import { Monitor, FileSearch, FilePenLine, Download, ListChecks } from "lucide-react";

/** Owner-requested phone presentation. Desktop resume tools remain unchanged at sm+. */
export default function MobileResumeDesktopNotice() {
  const features = [
    { icon: FileSearch, text: "Review Your Resume Details" },
    { icon: FilePenLine, text: "Edit Your Resume Profile" },
    { icon: Download, text: "Export Your Resume as Word or Text" },
    { icon: ListChecks, text: "Manage Your Skills and Experience" },
  ];
  return <section className="sm:hidden min-h-[calc(100dvh-120px)] bg-[#F4F5F7] px-3 pt-3 pb-12" data-testid="mobile-resume-desktop-notice">
    <h1 className="text-center text-[18px] font-bold text-slate-950 mb-8">Resume</h1>
    <div className="rounded-[20px] bg-gradient-to-r from-[#DCEEFF] to-[#E6EEFF] px-6 py-8 text-center">
      <Monitor className="w-10 h-10 mx-auto mb-5 text-[#2563EB]" aria-hidden="true" />
      <p className="text-[14px] leading-[20px] text-slate-950">To use Career Monke&apos;s resume tools, including reviewing your details and exporting your resume, please use a computer to access them.</p>
    </div>
    <h2 className="text-center text-[19px] font-semibold text-slate-950 mt-6 mb-4">Visit PC and Enjoy</h2>
    <ul className="rounded-[20px] bg-white px-4 divide-y divide-slate-100">
      {features.map(({icon: Icon,text})=><li key={text} className="flex items-center gap-3 min-h-[60px] py-4 text-[14px] leading-[20px] text-slate-950"><Icon className="h-6 w-6 shrink-0 text-[#2563EB]" aria-hidden="true" /><span>{text}</span></li>)}
    </ul>
  </section>;
}
