// On Cloudflare Pages (@cloudflare/next-on-pages / Vercel CLI), omit `output: "export"`
// so Next.js builds the Edge server route handlers into .vercel/output/functions.
// On Netlify (NETLIFY=true) or default local builds, keep `output: "export"`
// so Netlify's publish="out" build is 100% unaffected.
const isCloudflareBuild =
  process.env.CF_PAGES === "1" ||
  process.env.NEXT_ON_PAGES === "1" ||
  process.env.VERCEL === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isCloudflareBuild ? {} : { output: "export" }),
  reactStrictMode: true,
  images: {
    domains: ["images.unsplash.com", "randomuser.me", "avatar.iran.liara.run", "i.pravatar.cc"],
    unoptimized: true,
  },
};

export default nextConfig;
