const isNetlifyProduction = process.env.CONTEXT === "production";
const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    if (isNetlifyProduction) {
      throw new Error(
        `[Production Build Error] Missing required environment variable: ${envVar}. Set it in Netlify production environment variables.`
      );
    } else {
      console.warn(
        `[Build Warning] Missing ${envVar}. Non-production context (CONTEXT=${process.env.CONTEXT || "local/ci"}); continuing build.`
      );
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  images: {
    domains: ["images.unsplash.com", "randomuser.me", "avatar.iran.liara.run", "i.pravatar.cc"],
    unoptimized: true,
  },
};

export default nextConfig;
