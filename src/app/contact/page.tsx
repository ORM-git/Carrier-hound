import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

export const metadata = {
  title: "Contact Us | CareerMonke",
  description: "Contact information and official corporate details for CareerMonke and Olive Ridley Media Private Limited.",
  alternates: {
    canonical: "https://careermonke.com/contact",
  },
};

export default function ContactUsPage() {
  return (
    <main className="min-h-screen bg-white text-[#09090B] py-16 px-6">
  <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Contact", path: "/contact" }]} />
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
          Contact Us
        </h1>
        <p className="text-xs text-gray-500 font-mono">Last updated: November 10, 2026</p>

        <p className="mb-2">
          If you have any questions about our job discovery feeds, AI tools, subscription billing, or legal policies, please reach out to our team. We respond to all inquiries within 5-7 working days.
        </p>

        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Brand Platform:</strong> CareerMonke
          </li>
          <li>
            <strong>Corporate Legal Entity:</strong> Olive Ridley Media Private Limited
          </li>
          <li>
            <strong>Registered Office:</strong> Flat No. 712, 7th Floor, Block C-2, Balaji Complex, Jharpada, Bhubaneswar, Khordha, Odisha 751006, India
          </li>
          <li>
            <strong>Support Email:</strong>{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>
          </li>
          <li>
            <strong>Phone:</strong>{" "}
            <a
              href="tel:+919124618200"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              +91-9124618200
            </a>
          </li>
        </ul>

        <h2 className="text-base font-semibold text-[#09090B] mt-6 mb-2">Grievance Officer</h2>
        <p className="mb-2">
          For any grievance about how your personal data is handled, contact our designated Grievance Officer:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Grievance Officer:</strong> Binit Kumar, Olive Ridley Media Private Limited
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
          Grievances are acknowledged and resolved within 5-7 working days.
        </p>

        <footer className="pt-8 border-t border-gray-200 text-xs text-gray-500 flex flex-wrap items-center justify-between gap-2">
          <Link href="/" className="text-blue-600 hover:underline">
            &larr; Return to Homepage
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/about" className="hover:text-gray-900 transition-colors">About Us</Link>
            <Link href="/pricing" className="hover:text-gray-900 transition-colors">Pricing</Link>
            <Link href="/privacy-policy" className="hover:text-gray-900 transition-colors">Privacy Policy</Link>
            <Link href="/terms-and-conditions" className="hover:text-gray-900 transition-colors">Terms &amp; Conditions</Link>
            <Link href="/refund-policy" className="hover:text-gray-900 transition-colors">Cancellation &amp; Refund Policy</Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
