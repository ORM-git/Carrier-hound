import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

export const metadata = {
  title: "About Us | CareerMonke",
  description:
    "CareerMonke is a small team building an AI job-search tool for job seekers to find jobs, tailor resumes per job, and track applications.",
  alternates: {
    canonical: "https://careermonke.com/about",
  },
};

export default function AboutUsPage() {
  return (
    <main id="main-content" className="min-h-screen bg-white text-[#09090B] py-16 px-6">
      <BreadcrumbJsonLd
        trail={[
          { name: "Home", path: "/" },
          { name: "About Us", path: "/about" },
        ]}
      />

      {/* Brand header */}
      <div className="max-w-[680px] mx-auto flex items-center justify-between mb-10 pb-4 border-b border-gray-200">
        <Link href="/" className="inline-flex items-center gap-2 text-[#2563EB] group">
          <div className="w-8 h-8 rounded-full bg-[#2563EB] text-white flex items-center justify-center">
            <BrandIcon className="w-4 h-4 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-[#2563EB]">CareerMonke</span>
        </Link>
        <nav aria-label="Public navigation" className="flex items-center gap-4 text-xs sm:text-sm font-medium text-[#4B5563]">
          <Link href="/pricing" className="hover:text-[#2563EB] transition-colors">
            Pricing
          </Link>
          <Link href="/login" className="hover:text-[#2563EB] transition-colors">
            Log in
          </Link>
        </nav>
      </div>

      {/* Main content container */}
      <div className="max-w-[680px] mx-auto text-sm sm:text-base leading-relaxed text-[#4B5563] space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#09090B] tracking-tight">
            About Us
          </h1>
          <p>
            We are a small team building an AI job-search tool for job seekers. Searching for a new role takes time and focus, so we built CareerMonke to bring the everyday steps of a job search into one straightforward workspace.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-base sm:text-lg font-semibold text-[#09090B]">
            What CareerMonke Helps You Do
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
            <div className="rounded-xl border border-gray-200 bg-[#F8F9FA] p-4 space-y-1.5">
              <div className="text-sm font-semibold text-[#09090B]">Find jobs</div>
              <p className="text-xs sm:text-sm text-[#4B5563] leading-relaxed">
                Search and filter remote and worldwide roles that match the kind of work you are looking for.
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-[#F8F9FA] p-4 space-y-1.5">
              <div className="text-sm font-semibold text-[#09090B]">Tailor resumes per job</div>
              <p className="text-xs sm:text-sm text-[#4B5563] leading-relaxed">
                Prepare a tailored resume and cover letter for each role you want to apply to.
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-[#F8F9FA] p-4 space-y-1.5">
              <div className="text-sm font-semibold text-[#09090B]">Track applications</div>
              <p className="text-xs sm:text-sm text-[#4B5563] leading-relaxed">
                Keep your saved roles, submitted applications, and interview stages organized in one place.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-5 space-y-1.5">
          <h2 className="text-base font-semibold text-[#09090B]">Contact</h2>
          <p className="text-sm text-[#4B5563]">
            Questions or feedback? Email us at{" "}
            <a
              href="mailto:support@careermonke.com"
              className="font-medium text-[#2563EB] underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>
            .
          </p>
        </div>

        <footer className="pt-8 border-t border-gray-200 text-xs text-gray-500 flex flex-wrap items-center justify-between gap-2">
          <Link href="/" className="text-[#2563EB] hover:underline">
            &larr; Return to Homepage
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/about" className="hover:text-gray-900 transition-colors">
              About Us
            </Link>
            <Link href="/pricing" className="hover:text-gray-900 transition-colors">
              Pricing
            </Link>
            <Link href="/privacy-policy" className="hover:text-gray-900 transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms-and-conditions" className="hover:text-gray-900 transition-colors">
              Terms &amp; Conditions
            </Link>
            <Link href="/refund-policy" className="hover:text-gray-900 transition-colors">
              Cancellation &amp; Refund Policy
            </Link>
            <Link href="/contact" className="hover:text-gray-900 transition-colors">
              Contact Us
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
