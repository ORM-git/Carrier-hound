import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

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
        <p className="text-xs text-gray-500 font-mono">Last updated: October 30, 2026</p>

        <p className="mb-2">
          If you have any questions about our job discovery feeds, AI tools, active subscription billing, or legal policies, please feel free to reach out to our team. We aim to respond to all incoming inquiries within 24 to 48 business hours.
        </p>

        <ul className="list-disc pl-5 space-y-2 mb-2">
          <li>
            <strong>Brand Platform:</strong> CareerMonke
          </li>
          <li>
            <strong>Corporate Legal Entity:</strong> Olive Ridley Media Private Limited
          </li>
          <li>
            <strong>Registered Office / Corporate Address:</strong> BLOCK-C2, 7TH FLOOR, FLAT NO-712, BALAJI COMPLEX, BLOCK-C2, JHARPADA, BHUBANESWAR, Khordha, Odisha, 751006
          </li>
          <li>
            <strong>Primary Support Email:</strong>{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              support@careermonke.com
            </a>
          </li>
          <li>
            <strong>Grievance Officer / Customer Support Helpline:</strong>{" "}
            <a
              href="tel:+919124618200"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-800 transition-colors"
            >
              +91-9124618200
            </a>
          </li>
        </ul>

        <div className="pt-8 border-t border-gray-200 text-xs text-gray-500">
          <Link href="/" className="text-blue-600 hover:underline">
            &larr; Return to Homepage
          </Link>
        </div>
      </div>
    </main>
  );
}
