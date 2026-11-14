import React from "react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
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
    <div className="min-h-screen bg-white text-[#09090B] flex flex-col font-sans">
      <GuideHeader />
      <main id="main-content" className="flex-1 max-w-[680px] w-full mx-auto text-sm leading-relaxed text-[#4B5563] space-y-4 px-4 sm:px-6 py-12">
        <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Contact", path: "/contact" }]} />
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
      </main>
      <Footer />
    </div>
  );
}
