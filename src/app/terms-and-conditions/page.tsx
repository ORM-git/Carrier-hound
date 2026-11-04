import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

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
        <p className="text-xs text-gray-500 font-mono">Last updated: October 30, 2026</p>

        <p className="mb-2">
          Welcome to CareerMonke . These Terms and Conditions (&quot;Terms&quot;) constitute a legally binding agreement made between you, whether personally or on behalf of an entity (&quot;you&quot;, &quot;user&quot;, &quot;subscriber&quot;), and Olive Ridley Media Private Limited (&quot;the Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;), concerning your access to and use of the CareerMonke website, mobile applications, and platform tools.
        </p>

        <p className="mb-2">
          By accessing the site or purchasing a subscription, you agree that you have read, understood, and agreed to be bound by all of these Terms. If you do not agree with all of these Terms, you are explicitly prohibited from using the site and must discontinue use immediately.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Services Provided</h2>
        <p className="mb-2">
          CareerMonke provides access to an unindexed database of remote engineering, design, data, and product jobs sourced directly from company Applicant Tracking Systems (ATS), alongside AI-powered resume benchmarking, scoring, and refinement tools.
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

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Billing, Pricing, and Subscriptions</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Subscription Model:</strong> We offer weekly, monthly and quarterly paid membership tiers; plans are prepaid for a fixed duration and do not auto-renew; renew or upgrade extends your period.
          </li>
          <li>
            <strong>Payment Gateways:</strong> To ensure seamless financial operations across borders, all transactions are processed through secure, third-party payment gateways:
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li>
                <strong>Razorpay:</strong> Primarily used for domestic Indian transactions (INR), supporting UPI, NetBanking, and local cards.
              </li>
            </ul>
          </li>
          <li>
            <strong>Currency:</strong> Depending on your geographical location, you will be billed in either Indian Rupees (INR) or United States Dollars (USD/other global currencies).
          </li>
          <li>
            <strong>Price Changes:</strong> We reserve the right to modify subscription fees upon providing at least 30 days of advance notice to active subscribers via email.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Cancellation and Account Rules</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            You may cancel your subscription at any time via your account dashboard or by contacting{" "}
            <a href="mailto:support@careermonke.com" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              support@careermonke.com
            </a>.
          </li>
          <li>
            All sales are final. Your cancellation and refund workflows are governed exclusively by our separate{" "}
            <Link href="/refund-policy" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              Cancellation &amp; Refund Policy
            </Link>
            , which is incorporated into these Terms by reference.
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
