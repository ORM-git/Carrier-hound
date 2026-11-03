import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

export const metadata = {
  title: "Shipping & Delivery Policy | CareerMonke",
  description: "Shipping and digital service delivery terms for CareerMonke SaaS subscriptions and credit packs.",
  alternates: {
    canonical: "https://careermonke.com/shipping-and-delivery",
  },
};

export default function ShippingAndDeliveryPage() {
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
          Shipping &amp; Delivery Policy
        </h1>
        <p className="text-xs text-gray-500 font-mono">Last updated: November 3, 2026</p>

        <p className="mb-2">
          CareerMonke is operated by Olive Ridley Media Private Limited. CareerMonke is an electronic SaaS platform with no physical shipping; access and credits activated instantly after payment confirmation.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">1. Electronic SaaS Service</h2>
        <p className="mb-2">
          CareerMonke is an electronic SaaS service operated by Olive Ridley Media Private Limited. All features and subscriptions are delivered electronically via web browser.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">2. No Physical Shipping</h2>
        <p className="mb-2">
          Because CareerMonke provides only digital access and cloud software services, there is no physical shipping of goods or physical delivery. No parcel deliveries or physical shipments are involved with any plan or add-on pack.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">3. Instant Digital Access</h2>
        <p className="mb-2">
          All digital access and credits activated instantly after payment confirmation. Upon successful transaction completion, your account permissions and AI credit quotas are immediately updated and available for use.
        </p>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">4. Delay Handling via Support</h2>
        <p className="mb-2">
          In case of unexpected payment gateway reconciliation delays, network latency, or if your access and credits are not activated immediately after payment confirmation, delay handling via support is available by contacting{" "}
          <a
            href="mailto:support@careermonke.com"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
          >
            support@careermonke.com
          </a>{" "}
          with your order id and registered email address for immediate resolution.
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
