import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ToastContainer } from "react-toastify";
import BackToTop from "@/components/BackToTop";
import PageViewTracker from "@/components/analytics/PageViewTracker";
import BlockedAccountNotice from "@/components/auth/BlockedAccountNotice";

const inter = Inter({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-inter",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "CareerMonke — Unindexed Jobs & Remote Career Discovery",
  description: "Discover unindexed remote engineering, design, marketing, and data roles directly from verified employer career pages before they hit public aggregators.",
  metadataBase: new URL("https://careermonke.io"),
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} scroll-smooth`}>
      <body className="font-sans antialiased text-[#09090B] bg-white min-h-screen flex flex-col selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden w-full max-w-full">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded focus:shadow-lg focus:outline-none"
        >
          Skip to main content
        </a>
        <div id="main-content" className="flex-1 flex flex-col">
          {children}
        </div>
        <Suspense fallback={null}>
          <PageViewTracker />
        </Suspense>
        <BlockedAccountNotice />
        <BackToTop />
        <ToastContainer
          position="bottom-right"
          autoClose={3500}
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
          theme="light"
        />
      </body>
    </html>
  );
}
