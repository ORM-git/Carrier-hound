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
    // next/image (used by BrandIcon) reads these at module scope; without a value
    // the bare `process` reference throws ReferenceError in a non-Next browser bundle.
    "process.env.NEXT_RUNTIME": JSON.stringify(""),
    "process.env.NEXT_DEPLOYMENT_ID": JSON.stringify(""),
    "process.env.__NEXT_IMAGE_OPTS": "undefined",
    "process.env.__NEXT_OPTIMIZE_FONTS": JSON.stringify("false"),
  },
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
  },
});

console.log("Successfully bundled with esbuild JS API!");
