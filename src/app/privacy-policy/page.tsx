import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

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
  <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Privacy Policy", path: "/privacy-policy" }]} />
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
        <p className="text-xs text-gray-500 font-mono">Last updated: November 9, 2026</p>

        <p className="mb-2">
          Welcome to CareerMonke. This Privacy Policy explains how Olive Ridley Media Private Limited (&quot;the Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects, protects, uses, discloses, and processes your personal information when you use our website, mobile applications, and platform tools.
        </p>

        <p className="mb-2">
          By accessing our platform, you consent to the data practices described in this policy. Where the law requires a separate consent (for example, for optional cookies), we ask for it separately.
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
            <strong>Payment Information:</strong> For processing subscription plans, we collect non-sensitive transaction data (such as billing address, country of origin, and selected plan). We do not collect or store your complete credit/debit card numbers, UPI PINs, or netbanking credentials.
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
            <strong>To Provide Services:</strong> Activating premium job feeds, personalizing job matches, processing AI resume scores, and managing active member portals.
          </li>
          <li>
            <strong>To Process Payments Securely:</strong> All transactions are processed in Indian Rupees (INR) through Razorpay Software Private Limited, a PCI-DSS compliant payment gateway, via UPI, local cards, and netbanking networks.
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

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. How Our AI Features Process Your Resume Data</h2>
        <p className="mb-2">
          CareerMonke&apos;s AI features (resume match scoring, AI resume tailoring, and AI cover letter generation) run only when you explicitly start them for a specific job. This is how your data flows when they run:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>What is sent:</strong> the text of the resume or candidate profile you uploaded, and the text of the target job description. Nothing else is included.
          </li>
          <li>
            <strong>Who receives it:</strong> our AI processing provider, Groq, Inc. (GroqCloud API), over an encrypted connection. The request is made from our servers; your data is never sent to an AI provider directly from your browser, and AI provider keys are never exposed to your device.
          </li>
          <li>
            <strong>What it is used for:</strong> solely to generate the score, tailored resume, or cover letter you requested. We do not use your resume content to train models, and we do not send it to any other AI provider.
          </li>
          <li>
            <strong>What is stored:</strong> the generated result is saved to your account so you can download it again. Your uploaded resume files are stored in private cloud storage accessible only to your account until you delete them or close your account.
          </li>
          <li>
            <strong>How long Groq keeps it:</strong> Groq does not retain your inference inputs or outputs by default. It may keep temporary logs of inputs and outputs for up to 30 days (unless the law requires keeping them longer) only to troubleshoot platform reliability or investigate abuse, and it retains usage metadata that does not include your content. Processing happens on Groq&apos;s servers in the United States. See Groq&apos;s data documentation and privacy policy for details.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Data Sharing and Service Providers</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Service Providers:</strong> We share only the necessary fragments of your data with the providers that run the platform: Supabase (database, authentication, and file storage), Cloudflare and Netlify (hosting and content delivery), Google (sign-in and transactional email delivery), Sentry (error monitoring with personal identifiers removed before dispatch), Razorpay (payments), and Groq (AI processing, as described above).
          </li>
          <li>
            <strong>Cross-Border Transfers:</strong> Because CareerMonke caters to a global market, data collected from international jurisdictions may be securely stored and processed on cloud servers located outside your home region. We implement strict standard contractual clauses to ensure your data receives identical protection layers worldwide.
          </li>
          <li>
            <strong>No Selling of Personal Data:</strong> We do not trade, rent, sell, or distribute your private personal data or uploaded resumes to third-party recruitment agencies, brokers, or marketing networks.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">5. Your Privacy Rights and How to Exercise Them</h2>
        <p className="mb-2">
          Under India&apos;s Digital Personal Data Protection (DPDP) Act, you have the right to access your personal data, correct or update it, request its erasure, raise a grievance, and nominate another person to exercise these rights if you are unable to. If you live outside India, the law of your region may give you additional rights; contact us and we will honour every right that applies to our processing.
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Access and portability:</strong> you can export a copy of your account data at any time from your account settings.
          </li>
          <li>
            <strong>Correction:</strong> you can edit your profile, preferences, and uploaded resumes from your account at any time.
          </li>
          <li>
            <strong>Erasure:</strong> you can delete your account from your account settings. When you do, your profile, resumes, generated documents, saved jobs, and preferences are removed from our active systems: the account is deactivated immediately and the remaining records are permanently purged after a 30-day deletion window.
          </li>
          <li>
            <strong>Withdrawing consent:</strong> you can refuse or clear optional cookies through your browser settings at any time. AI features only run when you start them, so you can stop that processing by simply not using them, or by deleting the uploaded resume. To withdraw consent for all remaining processing, delete your account.
          </li>
          <li>
            <strong>By email:</strong> you can also exercise any of these rights by writing to{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>{" "}
            from your registered account email address. We process verified requests within 30 days.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">6. Data Retention</h2>
        <p className="mb-2">
          We keep personal information only for as long as it is needed for the purpose it was collected:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Account, profile, and resume data:</strong> kept until you delete it or close your account. Account deletion deactivates the account immediately and permanently purges the remaining personal records after a 30-day deletion window.
          </li>
          <li>
            <strong>Usage analytics (page views):</strong> 90 days.
          </li>
          <li>
            <strong>Payment gateway webhook records:</strong> 90 days.
          </li>
          <li>
            <strong>Transactional email logs:</strong> 180 days, so we can honour bounce and suppression handling.
          </li>
          <li>
            <strong>Administrative audit logs</strong> (records of administrative access to user data): 365 days.
          </li>
          <li>
            Platform-managed backups (run by our database provider) may retain deleted rows inside their own backup windows before they are overwritten.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">7. Security Practices</h2>
        <p className="mb-2">
          The security measures we actually operate include:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            All traffic is served over encrypted HTTPS connections.
          </li>
          <li>
            Payment and AI provider credentials are stored only on our servers and are never included in the code sent to your browser.
          </li>
          <li>
            Database row-level security restricts each user&apos;s rows to that user&apos;s own account, and uploaded resume files sit in private storage rather than public URLs.
          </li>
          <li>
            AI and account endpoints enforce per-user and per-network rate limits, daily generation caps, and idempotency checks to prevent abuse and duplicate charges.
          </li>
          <li>
            Administrative access to user data is recorded in an audit log that we review.
          </li>
          <li>
            Error monitoring scrubs personal identifiers (emails, IP addresses, user IDs) and credentials before any diagnostic event leaves the platform.
          </li>
        </ul>
        <p className="mb-2">
          No method of transmission or storage is perfectly secure, but we maintain these practices continuously and review them as the platform evolves.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">8. Grievance Officer</h2>
        <p className="mb-2">
          In accordance with the DPDP Act, our designated Grievance Officer for any question or complaint about how your personal data is handled is:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Grievance Officer:</strong> Orissa Lee Patnaik, Olive Ridley Media Private Limited
          </li>
          <li>
            Email:{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>
          </li>
          <li>
            Phone:{" "}
            <a
              href="tel:+919124618200"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              +91-9124618200
            </a>
          </li>
          <li>
            Address: Flat No. 712, 7th Floor, Block C-2, Balaji Complex, Jharpada, Bhubaneswar, Khordha, Odisha 751006, India
          </li>
        </ul>
        <p className="mb-2">
          We aim to acknowledge and resolve grievances within 5-7 working days of receiving them.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">9. Cookies and Tracking Mechanisms</h2>
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
