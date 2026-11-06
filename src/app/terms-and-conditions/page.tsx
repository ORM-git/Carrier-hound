import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

export const metadata = {
  title: "Terms and Conditions | CareerMonke",
  description: "Terms and conditions of service for CareerMonke job discovery and AI resume tailoring platform.",
  alternates: {
    canonical: "https://careermonke.com/terms-and-conditions",
  },
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white text-[#09090B] py-16 px-6">
  <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Terms and Conditions", path: "/terms-and-conditions" }]} />
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
        <p className="text-xs text-gray-500 font-mono">Last updated: November 6, 2026</p>

        <p className="mb-2">
          Welcome to CareerMonke. These Terms and Conditions (&quot;Terms&quot;) constitute a legally binding agreement made between you, whether personally or on behalf of an entity (&quot;you&quot;, &quot;user&quot;, &quot;subscriber&quot;), and Olive Ridley Media Private Limited (&quot;the Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;), concerning your access to and use of the CareerMonke website, mobile applications, and platform tools.
        </p>

        <p className="mb-2">
          By accessing the site or purchasing a subscription, you agree that you have read, understood, and agreed to be bound by all of these Terms. If you do not agree with all of these Terms, you are explicitly prohibited from using the site and must discontinue use immediately.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Services Provided</h2>
        <p className="mb-2">
          CareerMonke is a job discovery and career tools platform. Job listings on CareerMonke are collected, normalized, and kept current by our proprietary ingestion tools, which read publicly available company career pages and Applicant Tracking System (ATS) feeds. On top of this listing database we provide:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Personalized job matching:</strong> your profile and preferences are matched and ranked against the full listing database, including curated Top 10 matches and match explanations.
          </li>
          <li>
            <strong>AI resume tools:</strong> resume parsing, match scoring against a specific job description, and AI-tailored resume generation.
          </li>
          <li>
            <strong>AI cover letters:</strong> per-job cover letter generation grounded in your resume and the job description.
          </li>
          <li>
            <strong>Search, alerts, and tracking:</strong> filtered job search, saved jobs, application tracking, and email digests of new matches.
          </li>
        </ul>
        <p className="mb-2">
          AI-generated outputs are algorithmic suggestions to assist your own applications. CareerMonke does not guarantee interviews, employment, or hiring outcomes, and is not a recruitment agency or an employer.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">2. Eligibility and User Accounts</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            To use our services, you must create a member account. You agree to provide accurate, current, and complete information during registration.
          </li>
          <li>
            You are responsible for safeguarding your account login credentials. Sharing accounts, premium access keys, or scraping data for redistribution is strictly prohibited and will result in immediate termination without a refund.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Plans, Pricing, and Add-ons</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Subscription plans (prepaid, fixed duration):</strong>
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li>
                <strong>Weekly:</strong> ₹692 for 7 days of premium access, including 15 AI generation sets per 7-day period.
              </li>
              <li>
                <strong>Monthly:</strong> ₹1,499 for 30 days of premium access, including 60 AI generation sets per 30-day period.
              </li>
              <li>
                <strong>Quarterly:</strong> ₹3,999 for 90 days of premium access, including 60 AI generation sets per 30-day period.
              </li>
            </ul>
          </li>
          <li>
            One AI generation set is consumed when you run the AI resume tailoring or AI cover letter features, subject to a fair-use limit of 30 generations per day on every plan.
          </li>
          <li>
            <strong>Add-on packs:</strong> additional generation sets are available as one-time add-on packs of 10 sets for ₹149, 30 sets for ₹399, or 60 sets for ₹699. Add-on sets are used only after your plan quota is exhausted and expire 60 days after purchase.
          </li>
          <li>
            <strong>No auto-renewal:</strong> all plans are prepaid for a fixed duration and do not renew automatically. No recurring charge will ever be debited. You may purchase a new plan or upgrade at any time; renewing or upgrading extends your access period.
          </li>
          <li>
            <strong>Payment gateway:</strong> all transactions are processed in Indian Rupees (INR) through Razorpay, supporting UPI, NetBanking, and cards. We do not collect or store your complete card numbers, UPI PINs, or netbanking credentials.
          </li>
          <li>
            <strong>Price changes:</strong> we reserve the right to modify subscription fees upon providing at least 30 days of advance notice to active subscribers via email.
          </li>
          <li>
            <strong>Refunds:</strong> all sales are final, governed exclusively by our separate{" "}
            <Link href="/refund-policy" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              Cancellation &amp; Refund Policy
            </Link>
            , which is incorporated into these Terms by reference.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Cancellation, Renewal, and Access After Cancellation</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            Because every plan is prepaid and does not auto-renew, there is no recurring billing to cancel. Your plan simply expires at the end of its paid period and your account returns to the free tier unless you purchase again.
          </li>
          <li>
            If you stop using the service or ask us to close your subscription before the period ends, you keep premium access until the end of the period you already paid for. We do not provide refunds or credits for unused time or unused generation sets, except the limited payment-failure cases described in the{" "}
            <Link href="/refund-policy" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              Cancellation &amp; Refund Policy
            </Link>
            .
          </li>
          <li>
            You may delete your account at any time from your account settings or by contacting{" "}
            <a href="mailto:support@careermonke.com" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              support@careermonke.com
            </a>
            . Deleting your account removes your personal data as described in our{" "}
            <Link href="/privacy-policy" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              Privacy Policy
            </Link>
            .
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">5. Intellectual Property &amp; Acceptable Use</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            All software, content, designs, text, and AI model architectures on CareerMonke are the exclusive intellectual property of Olive Ridley Media Private Limited.
          </li>
          <li>
            You are granted a limited, non-transferable, revocable license to access the platform for individual, personal career discovery. You may not use automated scripts, bots, or scrapers to extract our job feeds or abuse our AI token allocations.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">6. Limitation of Liability &amp; Disclaimer</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            CareerMonke does not guarantee employment, interviews, or hiring placement. We aggregate publicly available corporate job listings and provide AI-generated optimization recommendations based on algorithmic feedback.
          </li>
          <li>
            The services are provided on an &quot;as-is&quot; and &quot;as-available&quot; basis. In no event shall Olive Ridley Media Private Limited be liable for any direct, indirect, incidental, or consequential damages arising out of your platform usage.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">7. Governing Law and Jurisdiction</h2>
        <p className="mb-2">
          These Terms shall be governed by and construed in accordance with the laws of India. Any legal actions or disputes arising out of these terms shall be subject to the exclusive jurisdiction of the courts located in Bhubaneswar, India.
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
