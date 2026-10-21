import type { Config } from "tailwindcss";

// Design tokens live in src/styles/tokens.css. Colors are RGB channel triples so
// Tailwind opacity modifiers (e.g. `bg-brand-600/80`) keep working.
const tokenColor = (name: string) => `rgb(var(--cm-${name}) / <alpha-value>)`;
const tokenScale = (prefix: string, steps: number[]) =>
  Object.fromEntries(steps.map((s) => [s, tokenColor(`${prefix}-${s}`)]));

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
          // Token scale (PART 1 redesign) — additive; legacy named keys below unchanged.
          ...tokenScale("brand", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
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
        surface: {
          DEFAULT: tokenColor("surface"),
          subtle: tokenColor("surface-subtle"),
          muted: tokenColor("surface-muted"),
          sunken: tokenColor("surface-sunken"),
        },
        line: {
          DEFAULT: tokenColor("line"),
          strong: tokenColor("line-strong"),
        },
        ink: {
          DEFAULT: tokenColor("ink"),
          muted: tokenColor("ink-muted"),
          subtle: tokenColor("ink-subtle"),
          inverse: tokenColor("ink-inverse"),
        },
        success: { DEFAULT: tokenColor("success-700"), ...tokenScale("success", [50, 100, 500, 600, 700]) },
        warning: { DEFAULT: tokenColor("warning-700"), ...tokenScale("warning", [50, 100, 500, 600, 700]) },
        danger: { DEFAULT: tokenColor("danger-600"), ...tokenScale("danger", [50, 100, 600, 700]) },
      },
      spacing: {
        // 8px rhythm: `p-tk-2` = 16px, `gap-tk-3` = 24px.
        "tk-half": "var(--cm-space-half)",
        "tk-1": "var(--cm-space-1)",
        "tk-2": "var(--cm-space-2)",
        "tk-3": "var(--cm-space-3)",
        "tk-4": "var(--cm-space-4)",
        "tk-5": "var(--cm-space-5)",
        "tk-6": "var(--cm-space-6)",
        "tk-8": "var(--cm-space-8)",
        "tk-10": "var(--cm-space-10)",
        "tk-12": "var(--cm-space-12)",
      },
      fontSize: {
        "tk-display": ["var(--cm-text-display)", { lineHeight: "var(--cm-leading-display)", letterSpacing: "-0.02em", fontWeight: "800" }],
        "tk-h1": ["var(--cm-text-h1)", { lineHeight: "var(--cm-leading-h1)", letterSpacing: "-0.02em", fontWeight: "800" }],
        "tk-h2": ["var(--cm-text-h2)", { lineHeight: "var(--cm-leading-h2)", letterSpacing: "-0.01em", fontWeight: "700" }],
        "tk-h3": ["var(--cm-text-h3)", { lineHeight: "var(--cm-leading-h3)", fontWeight: "700" }],
        "tk-body": ["var(--cm-text-body)", { lineHeight: "var(--cm-leading-body)" }],
        "tk-body-sm": ["var(--cm-text-body-sm)", { lineHeight: "var(--cm-leading-body-sm)" }],
        "tk-caption": ["var(--cm-text-caption)", { lineHeight: "var(--cm-leading-caption)" }],
      },
      zIndex: {
        "tk-base": "var(--cm-z-base)",
        "tk-raised": "var(--cm-z-raised)",
        "tk-sticky": "var(--cm-z-sticky)",
        "tk-header": "var(--cm-z-header)",
        "tk-dropdown": "var(--cm-z-dropdown)",
        "tk-overlay": "var(--cm-z-overlay)",
        "tk-modal": "var(--cm-z-modal)",
        "tk-toast": "var(--cm-z-toast)",
      },
      transitionDuration: {
        "tk-fast": "var(--cm-duration-fast)",
        "tk-base": "var(--cm-duration-base)",
        "tk-slow": "var(--cm-duration-slow)",
      },
      transitionTimingFunction: {
        "tk-entrance": "var(--cm-ease-entrance)",
        "tk-exit": "var(--cm-ease-exit)",
        "tk-standard": "var(--cm-ease-standard)",
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
        // Token motion (keyframes defined in src/styles/tokens.css)
        "tk-slide-down-in": "cm-slide-down-in var(--cm-duration-base) var(--cm-ease-entrance) both",
        "tk-slide-up-out": "cm-slide-up-out var(--cm-duration-fast) var(--cm-ease-exit) both",
        "tk-fade-in": "cm-fade-in var(--cm-duration-base) var(--cm-ease-entrance) both",
        "tk-fade-out": "cm-fade-out var(--cm-duration-fast) var(--cm-ease-exit) both",
        "tk-rise-in": "cm-rise-in var(--cm-duration-slow) var(--cm-ease-entrance) both",
        "tk-skeleton": "cm-skeleton-pulse 1.6s var(--cm-ease-standard) infinite",
      },
      borderRadius: {
        btn: "6px",
        card: "8px",
        panel: "12px",
        megamenu: "14px",
        "tk-xs": "var(--cm-radius-xs)",
        "tk-sm": "var(--cm-radius-sm)",
        "tk-md": "var(--cm-radius-md)",
        "tk-lg": "var(--cm-radius-lg)",
        "tk-xl": "var(--cm-radius-xl)",
        "tk-2xl": "var(--cm-radius-2xl)",
        "tk-full": "var(--cm-radius-full)",
      },
      boxShadow: {
        card: "0 12px 32px rgba(15,23,42,0.12)",
        megamenu: "0 20px 50px rgba(9,14,52,0.2)",
        "tk-xs": "var(--cm-shadow-xs)",
        "tk-sm": "var(--cm-shadow-sm)",
        "tk-md": "var(--cm-shadow-md)",
        "tk-lg": "var(--cm-shadow-lg)",
        "tk-xl": "var(--cm-shadow-xl)",
        "tk-focus": "var(--cm-shadow-focus)",
      },
    },
  },
  plugins: [],
};

export default config;
