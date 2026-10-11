import React from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";

export const metadata = {
  title: "404 - Page Not Found | CareerMonke",
  description: "The page you are looking for does not exist on CareerMonke.",
};

export default function NotFound() {
  return (
    <div className="min-h-screen bg-white text-[#09090B] flex flex-col justify-center items-center px-6 py-16">
      {/* Brand Icon */}
      <Link href="/" className="inline-flex items-center gap-2 text-blue-600 mb-8 group">
        <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
          <BrandIcon className="w-5 h-5 text-white" />
        </div>
        <span className="text-2xl font-bold tracking-tight text-blue-600">CareerMonke</span>
      </Link>

      <div className="max-w-md w-full text-center space-y-4">
        <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
          404 &bull; Page Not Found
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
          Lost in the jungle?
        </h1>

        <p className="text-sm sm:text-base text-gray-500 leading-relaxed">
          The page you are looking for does not exist or may have been moved. Let&apos;s get you back on track to finding your next remote role.
        </p>

        <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/"
            className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors shadow-sm"
          >
            &larr; Back to Homepage
          </Link>
          <Link
            href="/jobs"
            className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm transition-colors"
          >
            Browse Unindexed Jobs
          </Link>
        </div>
      </div>
    </div>
  );
}
