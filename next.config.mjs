import { withSentryConfig } from "@sentry/nextjs/config";

// On Cloudflare Pages (@cloudflare/next-on-pages / Vercel CLI), omit `output: "export"`
// so Next.js builds the Edge server route handlers into .vercel/output/functions.
// On Netlify (NETLIFY=true) or default local builds, keep `output: "export"`
// so Netlify's publish="out" build is 100% unaffected.
const isCloudflareBuild =
  process.env.CF_PAGES?.trim() === "1" ||
  process.env.NEXT_ON_PAGES?.trim() === "1" ||
  process.env.VERCEL?.trim() === "1";

const isProduction = process.env.NODE_ENV === "production";
const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    if (isProduction) {
      throw new Error(
        `[Production Build Error] Missing required environment variable: ${envVar}. Set it in your hosting provider's production environment variables.`
      );
    } else {
      console.warn(
        `[Build Warning] Missing ${envVar}. Non-production build (NODE_ENV=${process.env.NODE_ENV || "unset"}); continuing build.`
      );
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isCloudflareBuild ? {} : { output: "export" }),
  reactStrictMode: true,
  images: {
    domains: [],
    unoptimized: true,
  },
  experimental: {
    instrumentationHook: false,
  },
};

export default withSentryConfig(nextConfig, {
  org: "olive-ridley-media",
  project: "careermonke",
  silent: true,
  widenClientFileUpload: true,
  disableLogger: true,
  // Disable automatic server/edge handler instrumentation to prevent
  // duplicate webpack module identifier collisions under @cloudflare/next-on-pages
  autoInstrumentServerFunctions: false,
  autoInstrumentMiddleware: false,
  autoInstrumentAppDirectory: false,
});
