import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "#2563EB",
          foreground: "hsl(var(--primary-foreground))",
          hover: "#1D4ED8",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          blue: "#2563EB",
          blueHover: "#1D4ED8",
          blueTint: "#F8FAFF",
          navy: "#090E34",
          headlineInk: "#142033",
          foreground: "#09090B",
          muted: "#4B5563",
          guideText: "rgb(99, 115, 129)",
          border: "#E4E4E7",
          softBlueBorder: "#DBE3EF",
          faqBg: "#F3F4F6",
          contactBg: "#F9FAFB",
          star: "#EAB308",
        },
      },
      maxWidth: {
        content: "1120px",
        container: "1280px",
      },
      keyframes: {
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(calc(-100% - var(--gap)))" },
        },
      },
      animation: {
        marquee: "marquee var(--duration) linear infinite",
      },
      borderRadius: {
        btn: "6px",
        card: "8px",
        panel: "12px",
        megamenu: "14px",
      },
      boxShadow: {
        card: "0 12px 32px rgba(15,23,42,0.12)",
        megamenu: "0 20px 50px rgba(9,14,52,0.2)",
      },
    },
  },
  plugins: [],
};

export default config;
