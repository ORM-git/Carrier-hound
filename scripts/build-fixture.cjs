const esbuild = require("esbuild");
const path = require("path");

esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "render-onboarding-fixture.tsx")],
  bundle: true,
  outfile: path.resolve(process.cwd(), "reports", "onboarding-redesign", "bundle.js"),
  alias: {
    "@": path.resolve(process.cwd(), "src"),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED": JSON.stringify("true"),
  },
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
  },
});

console.log("Successfully bundled with esbuild JS API!");
