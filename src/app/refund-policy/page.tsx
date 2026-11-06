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
        <p className="text-xs text-gray-500 font-mono">Last updated: November 3, 2026</p>

        <p className="mb-2">
          CareerMonke is operated by Olive Ridley Media Private Limited. All purchases are prepaid fixed-duration plans and add-on packs. As digital services, all sales final. Only a duplicate or failed-but-debited payment is reviewed and refunded to the original payment method within 5-7 business days.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Prepaid &amp; Non-Recurring Plans</h2>
        <p className="mb-2">
          All purchases on CareerMonke are prepaid fixed-duration plans and add-on packs with no recurring charges or auto-renewals. When you subscribe or purchase an add-on pack, your payment covers access strictly for the fixed duration purchased. Access does not renew automatically, and no recurring charges will ever be debited.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">2. Digital Services &amp; All Sales Final</h2>
        <p className="mb-2">
          CareerMonke provides instant digital access to unindexed job discovery tools and AI credits. Because our products are digital services, all sales final once access or credits are granted.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Exceptions: Duplicate or Failed-But-Debited Payments</h2>
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

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Review and Refund Timeline</h2>
        <p className="mb-2">
          Any eligible duplicate or failed-but-debited payment exception is reviewed and refunded to the original payment method within 5-7 business days following verification by our billing support team and payment gateway.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">5. How to Request a Refund</h2>
        <p className="mb-2">
          To request a review for an eligible duplicate or failed-but-debited payment, please contact our support team at{" "}
          <a
            href="mailto:support@careermonke.com"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
          >
            support@careermonke.com
          </a>{" "}
          with your order id and registered account email address.
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
