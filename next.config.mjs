const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(
      `[Startup Validation Error] Missing required environment variable: ${envVar}. Define it in your environment or .env.local before building or starting the app.`
    );
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
