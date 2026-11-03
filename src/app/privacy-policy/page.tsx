import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

export const metadata = {
  title: "Privacy Policy | CareerMonke",
  description: "Privacy policy and data protection terms for CareerMonke job discovery and AI resume tailoring service.",
  alternates: {
    canonical: "https://careermonke.com/privacy-policy",
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
        <p className="text-xs text-gray-500 font-mono">Last updated: October 30, 2026</p>

        <p className="mb-2">
          Welcome to CareerMonke. This Privacy Policy explains how Olive Ridley Media Private Limited (&quot;the Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects, protects, uses, discloses, and processes your personal information when you use our website, mobile applications, and platform tools.
        </p>

        <p className="mb-2">
          We are committed to maintaining the highest standards of data privacy for both our domestic users in India and our international users worldwide. By accessing our platform, you consent to the data practices described in this policy.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Information We Collect</h2>
        <p className="mb-2">
          We collect information that you directly provide to us, as well as data automatically generated during your platform usage:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Account Information:</strong> Name, email address, password, account preferences, and professional profiles.
          </li>
          <li>
            <strong>User Content:</strong> Resumes, CVs, cover letters, or career text fragments uploaded in PDF or Word formats to execute our AI resume optimization features.
          </li>
          <li>
            <strong>Payment Information:</strong> For processing subscription plans, we collect non-sensitive transaction data (such as billing address, country of origin, and selected plan). We do not collect or store your complete credit/debit card numbers or bank account pins.
          </li>
          <li>
            <strong>Usage &amp; Device Data:</strong> IP addresses, browser types, operating systems, and device identifiers collected automatically via operational tracking tags and session cookies.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">2. Legal Basis and How We Use Your Data</h2>
        <p className="mb-2">
          We process your personal information under the following legal frameworks to fulfill our core services:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>To Provide Services:</strong> Activating premium job feeds, processing AI resume scores, and managing active member portals.
          </li>
          <li>
            <strong>To Process Payments Securely:</strong> We leverage secure, PCI-DSS compliant third-party payment infrastructure partners:
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li>
                <strong>Razorpay Software Private Limited:</strong> Used to securely process domestic payments within India (INR) via UPI, local cards, and netbanking networks.
              </li>
              <li>
                <strong>Stripe, Inc.:</strong> Used to securely process international payments and multi-currency transactions across global credit, debit, and localized digital banking networks.
              </li>
            </ul>
          </li>
          <li>
            <strong>Customer Support:</strong> Communicating updates, service notifications, and resolving incoming technical issues sent to{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>.
          </li>
          <li>
            <strong>Platform Security:</strong> Detecting, mitigating, and preventing data scraping, automated bot exploitation, or fraudulent transactions.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Data Sharing and International Transfers</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Service Providers:</strong> We share necessary fragments of your data with trusted cloud storage entities, AI model processing API endpoints, and our designated payment processing platforms (Razorpay and Stripe) to execute your requested tasks.
          </li>
          <li>
            <strong>Cross-Border Transfers:</strong> Because CareerMonke caters to a global market, data collected from international jurisdictions may be securely stored and processed on cloud servers located outside your home region. We implement strict standard contractual clauses to ensure your data receives identical protection layers worldwide.
          </li>
          <li>
            <strong>No Selling of Personal Data:</strong> We do not trade, rent, sell, or distribute your private personal data or uploaded resumes to third-party recruitment agencies, brokers, or marketing networks.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Global Privacy Rights &amp; Compliance</h2>
        <p className="mb-2">
          Depending on your geographical location, you possess distinct legal rights regarding your private data:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Indian Users (DPDP Act Compliance):</strong> You maintain the right to view, correct, update, or completely request the deletion of your account parameters.
          </li>
          <li>
            <strong>European Union Users (GDPR Compliance):</strong> You possess the right to data portability, the right to restrict specific backend data processing, and the absolute right to be forgotten.
          </li>
          <li>
            <strong>California Users (CCPA Compliance):</strong> You maintain the right to request clear disclosure of what exact personal data pieces have been mapped, alongside a notice that we do not monetize or distribute user lists.
          </li>
          <li>
            <strong>Execution:</strong> To exercise any of your privacy rights, drop a direct request from your verified account email address to{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>. We will process the structural data removal or update within 30 days.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">5. Data Retention Boundaries</h2>
        <p className="mb-2">
          We keep your personal information and uploaded files only for as long as your premium or free member account remains active in our system. If you delete your account, your parameters are scrubbed from our active production database. Backup registry snapshots are systematically overwritten within standard engineering cycles.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">6. Cookies and Tracking Mechanisms</h2>
        <h3 className="text-sm font-semibold text-[#09090B] mt-3 mb-1">Cookies and monitoring</h3>
        <p className="mb-2">
          CareerMonke employs a minimal, privacy-first approach to browser storage and operational tracking:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Essential Cookies &amp; Storage:</strong> We use essential cookies and browser local storage strictly for authentication and session management (preserving your authenticated Supabase session) and remembering your interface preferences (such as acknowledged notices and filter states). These are required for the application to function.
          </li>
          <li>
            <strong>Privacy-Respecting Error Monitoring:</strong> We utilize Sentry error monitoring to diagnose crashes and keep the service operational. Our client and edge configurations enforce strict PII scrubbing before any event is dispatched: no email addresses, IP addresses, usernames, or user IDs are retained, and all sensitive auth tokens, keys, and passwords are fully redacted from requests and breadcrumbs.
          </li>
          <li>
            <strong>Operational Analytics:</strong> We operate a lightweight, first-party beacon for basic usage metrics (such as page views and route transitions) to monitor platform health. This internal analytics logging is strictly gated behind your cookie consent.
          </li>
          <li>
            <strong>No Advertising Cookies:</strong> We have a strict policy: no advertising cookies, third-party marketing pixels, or cross-site tracking technologies are present or used on CareerMonke. We do not track you across other websites or sell your data to advertisers.
          </li>
          <li>
            <strong>Managing Your Preferences:</strong> Users can clear cookies at any time through their web browser settings, or refuse non-essential browser storage. Please note that clearing essential storage may require you to sign in again to access protected features.
          </li>
        </ul>
        <p className="mb-2">
          For any questions or requests regarding our cookie practices, please contact us at{" "}
          <a
            href="mailto:support@careermonke.com"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
          >
            support@careermonke.com
          </a>.
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
