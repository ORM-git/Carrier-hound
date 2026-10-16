import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

export const metadata = {
  title: "Privacy Policy | CareerMonke",
  description: "Privacy policy and data protection terms for CareerMonke job discovery and AI resume tailoring service.",
  alternates: {
    canonical: "https://careerhound.netlify.app/privacy-policy",
  },
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-white text-[#09090B] py-16 px-6">
      {/* Small blue logo (max-width 200px) centered at top */}
      <div className="max-w-[200px] mx-auto text-center mb-10">
        <Link href="/" className="inline-flex items-center gap-2 text-blue-600 group">
          <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center">
            <BrandIcon className="w-4 h-4 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-blue-600">CareerMonke</span>
        </Link>
      </div>

      {/* Narrow container with minimal styling */}
      <div className="max-w-[680px] mx-auto text-sm leading-relaxed text-[#4B5563] space-y-4">
        <h1 className="text-2xl sm:text-3xl font-bold text-[#09090B] tracking-tight">
          Privacy Policy
        </h1>
        <p className="text-xs text-gray-500 font-mono">Last Updated: October 10, 2026</p>

        <p className="mb-2">
          1. Information We Collect. CareerMonke collects information you provide directly to us when creating an account, subscribing to job alert notifications, uploading resumes, or contacting customer support:
        </p>
        <p className="mb-2">
          - <strong>Account &amp; Contact Information:</strong> Your email address, authentication credentials, communication logs, and job search preferences (such as target titles, locations, and salary expectations).
        </p>
        <p className="mb-2">
          - <strong>Resume &amp; Professional Data:</strong> When you use our AI Resume or Cover Letter features, you may upload your existing resume or enter professional credentials. We extract relevant career information, including your full name, contact information, work experience, past employers, job titles, technical skills, certifications, and educational history.
        </p>
        <p className="mb-2">
          - <strong>Telemetry &amp; Usage Diagnostics:</strong> We automatically collect standard diagnostic telemetry, including browser type, operating system, IP address, device metadata, and referral paths to maintain service performance and prevent automated scraping abuse.
        </p>
        <p className="mb-2">
          - <strong>Payment Information:</strong> We do not store sensitive payment card details or bank account numbers on our servers; transactions are processed directly by PCI-compliant payment partners.
        </p>

        <p className="mb-2">
          2. Artificial Intelligence Processing and Sub-Processors. CareerMonke incorporates artificial intelligence to tailor your resume and draft customized cover letters for specific job requisitions:
        </p>
        <p className="mb-2">
          - <strong>Third-Party AI Processor (Groq):</strong> We transmit user resume contents, selected professional experience points, and target job descriptions to our cloud AI sub-processor, Groq, Inc. (groq.com), which executes high-speed inference on our behalf.
        </p>
        <p className="mb-2">
          - <strong>Limited Scope of Processing:</strong> Data transferred to Groq is processed strictly to generate tailored resumes, cover letters, keyword alignment summaries, and ATS compatibility match scores requested by you.
        </p>
        <p className="mb-2">
          - <strong>No Foundation Model Training:</strong> Your private resume contents and personally identifiable details are not used by CareerMonke or our AI sub-processor to train public foundation models without your express authorization.
        </p>

        <p className="mb-2">
          3. How We Use Collected Data. We utilize collected information solely to provide, operate, and enhance our job discovery and resume optimization services, including:
        </p>
        <p className="mb-2">
          - Delivering secure magic-link authentications and session management tokens.
        </p>
        <p className="mb-2">
          - Tailoring resumes and generating cover letters matched to specific corporate job descriptions.
        </p>
        <p className="mb-2">
          - Sending transactional updates and customized job alerts based on your preferences.
        </p>
        <p className="mb-2">
          - Detecting fraudulent bot automation, rate-limit circumvention, or unauthorized database extraction.
        </p>

        <p className="mb-2">
          4. Data Storage, Retention, and Security.
        </p>
        <p className="mb-2">
          - <strong>Secure Cloud Storage:</strong> All user profile data, uploaded resumes, and generated documents are stored in secure cloud database infrastructure provided by Supabase (PostgreSQL), protected with Row Level Security (RLS) policies so that only authenticated account owners can access their records.
        </p>
        <p className="mb-2">
          - <strong>Retention Period:</strong> Your uploaded resumes and generated career documents are retained for as long as your account remains active, allowing you to access and re-download them at any time. When you remove a resume or delete your account, the associated data is purged from active databases.
        </p>
        <p className="mb-2">
          - <strong>Security Safeguards:</strong> We enforce Transport Layer Security (TLS 1.3) encryption in transit across all web and API traffic, encryption at rest in our databases, server-side secret isolation, and strict administrative access controls.
        </p>

        <p className="mb-2">
          5. Third-Party Job Listings and Employer Forms. When you click an &ldquo;Apply&rdquo; or destination link on CareerMonke, you are routed directly to official third-party employer applicant tracking systems (such as Greenhouse, Lever, Ashby, or Workday). CareerMonke never shares or transfers your private resume data to prospective employers unless you explicitly submit your application on their respective portal.
        </p>

        <p className="mb-2">
          6. User Rights and Data Erasure. You maintain full ownership and control over your personal data:
        </p>
        <p className="mb-2">
          - <strong>Access and Portability:</strong> You may view and export your saved profile data and generated resumes directly from your user dashboard at any time.
        </p>
        <p className="mb-2">
          - <strong>Deletion Requests:</strong> You may permanently delete individual resumes or delete your entire account through account settings, or by emailing our privacy team at <a href="mailto:support@careermonke.com" className="text-blue-600 hover:underline">support@careermonke.com</a>.
        </p>
        <p className="mb-2">
          - <strong>Response Timeline:</strong> Valid account deletion and data erasure requests submitted via email will be processed and confirmed within thirty (30) business days.
        </p>

        <p className="mb-2">
          7. Cookies and Local Storage. We utilize minimal local browser storage and session cookies strictly necessary to maintain authentication states and remember your active search filter preferences. You may disable cookies in your browser settings at any time without impacting public job listing search.
        </p>

        <p className="mb-2">
          8. Policy Updates. We reserve the right to amend this Privacy Policy periodically to reflect technological, operational, or legal developments. Significant updates will be reflected by the revised &ldquo;Last Updated&rdquo; date at the top of this page.
        </p>

        <div className="pt-8 border-t border-gray-200 text-xs text-gray-500">
          <Link href="/" className="text-blue-600 hover:underline">
            &larr; Return to Homepage
          </Link>
        </div>
      </div>
    </main>
  );
}
