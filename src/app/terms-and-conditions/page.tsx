import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

export const metadata = {
  title: "Terms and Conditions | CareerMonke",
  description: "Terms and conditions of service for CareerMonke job discovery and AI resume tailoring platform.",
  alternates: {
    canonical: "https://careerhound.netlify.app/terms-and-conditions",
  },
};

export default function TermsPage() {
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
          Terms and Conditions
        </h1>
        <p className="text-xs text-gray-500 font-mono">Last Updated: October 10, 2026</p>

        <p className="mb-2">
          1. Acceptance of Terms &amp; Business Identity. By accessing or using the CareerMonke website, application, or features, you agree to be legally bound by these Terms and Conditions. CareerMonke is operated by CareerMonke. For all official notices, billing inquiries, or customer support, please contact us at <a href="mailto:support@careermonke.com" className="text-blue-600 hover:underline">support@careermonke.com</a>. If you do not agree to these terms, you must discontinue using our services immediately.
        </p>

        <p className="mb-2">
          2. Nature of Service. CareerMonke operates as an informational job search engine and career enablement platform designed to catalog unindexed and publicly published employment opportunities.
        </p>
        <p className="mb-2">
          - CareerMonke is not an employment agency, headhunter, staffing firm, recruiter, or direct employer.
        </p>
        <p className="mb-2">
          - We make no warranty or guarantee regarding interview invitations, hiring outcomes, or decisions made by prospective employers.
        </p>

        <p className="mb-2">
          3. Permitted and Prohibited Conduct. You are granted a personal, non-exclusive, revocable license to browse job listings and use our career preparation tools for your own bona fide personal employment search.
        </p>
        <p className="mb-2">
          - You agree not to systematically scrape, extract, copy, resell, or redistribute database contents without explicit prior written authorization.
        </p>
        <p className="mb-2">
          - Automated querying, flood attacks, spamming employer links, or attempting unauthorized bypass of authentication or paywalls will result in immediate account and IP termination.
        </p>

        <p className="mb-2">
          4. Job Listings and Periodic Ingestion. Requisition details, compensation indicators, and company metadata are indexed and updated periodically from public company career pages and direct ATS feeds (including Greenhouse, Lever, Ashby, and Workday). Because employers independently modify, close, or archive job postings without notice, CareerMonke cannot guarantee that any cataloged position remains active at the moment you apply. All applications are submitted directly on the respective employer&apos;s external portal.
        </p>

        <p className="mb-2">
          5. AI Resume and Document Tailoring. CareerMonke provides automated AI tools to re-frame and tailor user-submitted resumes and draft job-specific cover letters.
        </p>
        <p className="mb-2">
          - AI suggestions, keyword matching, and ATS compatibility scores are advisory aids provided for convenience.
        </p>
        <p className="mb-2">
          - Users bear sole responsibility for verifying the complete accuracy, truthfulness, and authenticity of all statements, credentials, and experience before submitting any document to employers.
        </p>

        <p className="mb-2">
          6. Subscriptions and Payment Terms (Applies Upon Launch of Paid Plans).
        </p>
        <p className="mb-2">
          - <strong>Billing &amp; Auto-Renewal:</strong> When paid subscriptions are active, CareerMonke Pro is billed on a recurring monthly basis at the posted subscription rate. Subscriptions auto-renew automatically at the end of each billing cycle unless cancelled prior to the renewal date.
        </p>
        <p className="mb-2">
          - <strong>Cancellation:</strong> You may cancel your subscription at any time through your account settings or by emailing <a href="mailto:support@careermonke.com" className="text-blue-600 hover:underline">support@careermonke.com</a>. Upon cancellation, you retain full Pro access until the conclusion of your current prepaid billing cycle, with no subsequent charges.
        </p>

        <p className="mb-2">
          7. Refund Policy.
        </p>
        <p className="mb-2">
          - <strong>Immediate Compute Consumption:</strong> Because AI resume tailoring and cover letter generation consume immediate third-party computational GPU/LLM infrastructure upon execution, subscription fees are non-refundable once any AI document has been generated in the active billing period.
        </p>
        <p className="mb-2">
          - <strong>Seven-Day Technical Defect Exception:</strong> If you subscribe and do not generate any AI documents, or if an unresolvable technical fault on our platform prevents you from accessing Pro features, you may request a full refund within seven (7) calendar days of initial billing by contacting <a href="mailto:support@careermonke.com" className="text-blue-600 hover:underline">support@careermonke.com</a>.
        </p>

        <p className="mb-2">
          8. Limitation of Liability. To the fullest extent permitted by applicable law, CareerMonke, its operators, affiliates, and licensors shall not be liable for any indirect, incidental, consequential, or punitive damages arising from your access to or inability to use the platform, including missed employment opportunities or errors in third-party job listings.
        </p>

        <p className="mb-2">
          9. Governing Law and Jurisdiction. These Terms and Conditions shall be governed by, interpreted, and construed in accordance with the substantive laws of India. Any legal dispute, claim, or proceeding arising out of or related to these terms shall be subject to the exclusive jurisdiction of the competent courts located in Bengaluru, Karnataka, India.
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
