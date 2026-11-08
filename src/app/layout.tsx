import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "@/styles/tokens.css";
import "./globals.css";
import { ToastContainer } from "react-toastify";
import BackToTop from "@/components/BackToTop";
import PageViewTracker from "@/components/analytics/PageViewTracker";
import WebVitalsTracker from "@/components/analytics/WebVitalsTracker";
import GlobalErrorReporter from "@/components/monitoring/GlobalErrorReporter";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import BlockedAccountNotice from "@/components/auth/BlockedAccountNotice";
import CookieNotice from "@/components/CookieNotice";
import { getConnectionHints } from "@/lib/seo/structuredData";
import RouteFocusManager from "@/components/a11y/RouteFocusManager";
import JsonLd from "@/components/seo/JsonLd";


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
  themeColor: "#2563EB",
};

const siteTitle = "CareerMonke — Unindexed Jobs & Remote Career Discovery";
const siteDescription =
  "Discover unindexed remote engineering, design, marketing, and data roles directly from verified employer career pages before they hit public aggregators.";

const ogImageUrl = "https://careermonke.com/careermonke.png";

export const metadata: Metadata = {
  title: siteTitle,
  description: siteDescription,
  metadataBase: new URL("https://careermonke.com"),
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": "/feed.xml",
    },
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: "https://careermonke.com",
    siteName: "CareerMonke",
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: siteTitle,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: [ogImageUrl],
  },
  robots: {
    index: true,
    follow: true,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const connectionHints = getConnectionHints();

  return (
    <html lang="en" className={`${inter.variable} scroll-smooth`}>
      <head>
        {connectionHints.map((origin) => (
          <link key={`preconnect-${origin}`} rel="preconnect" href={origin} />
        ))}
        {connectionHints.map((origin) => (
          <link key={`dns-prefetch-${origin}`} rel="dns-prefetch" href={origin} />
        ))}
        <JsonLd />
      </head>
      <body className="font-sans antialiased text-[#09090B] bg-white min-h-screen flex flex-col selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden w-full max-w-full">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded focus:shadow-lg focus:outline-none"
        >
          Skip to main content
        </a>
        <RouteFocusManager />
        <noscript>
          <div
            style={{
              padding: "2rem 1.5rem",
              margin: "1rem",
              border: "1px solid #DBE3EF",
              borderRadius: "0.75rem",
              backgroundColor: "#EFF6FF",
              color: "#09090B",
              fontFamily: "system-ui, sans-serif",
              textAlign: "center",
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
              CareerMonke needs JavaScript to run
            </p>
            <p style={{ margin: 0 }}>
              Please enable JavaScript in your browser to browse jobs and use
              your dashboard.
            </p>
          </div>
        </noscript>
        <div id="main-content" className="flex-1 flex flex-col">
          {children}
        </div>
        <Suspense fallback={null}>
          <PageViewTracker />
        </Suspense>
        <Suspense fallback={null}>
          <WebVitalsTracker />
        </Suspense>
        <GlobalErrorReporter />
        <BlockedAccountNotice />
        <CookieNotice />
        <ServiceWorkerRegistrar />
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

