import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

export const metadata = {
  title: "Cancellation & Refund Policy | CareerMonke",
  description: "Cancellation and refund policy for CareerMonke prepaid subscription plans and add-on credit packs.",
  alternates: {
    canonical: "https://careermonke.com/refund-policy",
  },
};

export default function RefundPolicyPage() {
  return (
    <main className="min-h-screen bg-white text-[#09090B] py-16 px-6">
  <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Refund Policy", path: "/refund-policy" }]} />
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
          Cancellation &amp; Refund Policy
        </h1>
        <p className="text-xs text-gray-500 font-mono">Last updated: November 6, 2026</p>

        <p className="mb-2">
          CareerMonke is operated by Olive Ridley Media Private Limited. All purchases are prepaid fixed-duration plans and add-on packs. As digital services, all sales are final. Only a duplicate or failed-but-debited payment is reviewed and refunded to the original payment method within 5-7 business days.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Prepaid Plans, No Auto-Renewal</h2>
        <p className="mb-2">
          Every CareerMonke plan (Weekly, Monthly, Quarterly) and every add-on pack is prepaid for a fixed duration. There are no recurring charges and no automatic renewals: your plan expires at the end of its paid period unless you choose to purchase again. Because nothing renews automatically, there is no recurring billing to cancel.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">2. Cancellation and Access After Cancellation</h2>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            If you decide to stop using CareerMonke before your paid period ends, you keep full premium access until the end of the period you already paid for. No further payment is ever taken.
          </li>
          <li>
            When a plan period ends, premium features and remaining plan quotas expire automatically. Your account, profile, resumes, and saved jobs stay available on the free tier.
          </li>
          <li>
            Add-on packs are valid for 60 days from purchase and expire automatically after that, whether or not the sets are used.
          </li>
          <li>
            You may also delete your account entirely at any time from your account settings; deletion removes your personal data as described in our{" "}
            <Link href="/privacy-policy" className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors">
              Privacy Policy
            </Link>
            .
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Digital Services &amp; All Sales Final</h2>
        <p className="mb-2">
          CareerMonke provides instant digital access to job discovery tools and AI generation credits. Because our products are digital services delivered immediately, all sales are final once access or credits are granted. We do not provide refunds or credits for unused time, unused generation sets, or expired add-on packs.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Exceptions: Duplicate or Failed-But-Debited Payments</h2>
        <p className="mb-2">
          We maintain a strict no refunds policy; only a duplicate or failed-but-debited payment is reviewed and refunded to the original payment method within 5-7 business days:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Duplicate Payment:</strong> Multiple debits occurred for the same order due to a network glitch or checkout timeout.
          </li>
          <li>
            <strong>Failed-But-Debited Payment:</strong> Your bank account or card was debited, but the payment failed to confirm on our platform and access or credits were not activated.
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">5. Review and Refund Timeline</h2>
        <p className="mb-2">
          Any eligible duplicate or failed-but-debited payment exception is reviewed and refunded to the original payment method within 5-7 business days following verification by our billing support team and payment gateway.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">6. How to Request a Review</h2>
        <p className="mb-2">
          To request a review for an eligible duplicate or failed-but-debited payment, or to ask about cancelling your account, please contact our support team at{" "}
          <a
            href="mailto:support@careermonke.com"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
          >
            support@careermonke.com
          </a>{" "}
          with your order id and registered account email address. We respond within 5-7 working days.
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
