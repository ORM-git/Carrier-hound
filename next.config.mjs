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
  output: "export",
  reactStrictMode: true,
  images: {
    domains: ["images.unsplash.com", "randomuser.me", "avatar.iran.liara.run", "i.pravatar.cc"],
    unoptimized: true,
  },
};

export default nextConfig;
