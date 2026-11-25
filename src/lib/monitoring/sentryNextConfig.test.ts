// Regression: @sentry/nextjs 11 reads autoInstrument* only under `webpack`. At the top level
// they are silently ignored, so production edge/server builds were still wrapped.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSentryConfig } from "@sentry/nextjs/config";

const ROOT = path.resolve(__dirname, "../../..");
const ENV_KEYS = ["NODE_ENV", "VERCEL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};

type WebpackFn = (config: object, ctx: object) => { module: { rules: unknown[] } };
type NextCfg = { webpack: WebpackFn; [k: string]: unknown };

// Run the SDK's webpack hook as a production build would and list Sentry wrapping targets.
function wrappedKinds(cfg: NextCfg, nextRuntime: "edge" | "nodejs"): string[] {
  const out = cfg.webpack(
    { module: { rules: [] }, plugins: [], resolve: {} },
    { isServer: true, nextRuntime, dev: false, dir: ROOT, buildId: "test", config: cfg, defaultLoaders: {}, webpack: { DefinePlugin: class {} } },
  );
  return JSON.stringify(out.module.rules).match(/"wrappingTargetKind":"[a-z-]+"/g) ?? [];
}

let repoConfig: NextCfg;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env as Record<string, string>, {
    NODE_ENV: "production",
    VERCEL: "1", // Cloudflare/next-on-pages branch: real edge route handlers, no static export
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  });
  repoConfig = (await import(pathToFileURL(path.join(ROOT, "next.config.mjs")).href)).default;
});

afterAll(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("next.config.mjs Sentry auto-instrumentation", () => {
  it("adds no server wrapping loaders to the production edge build", () => {
    expect(wrappedKinds(repoConfig, "edge")).toEqual([]);
  });

  it("adds no server wrapping loaders to the production nodejs build", () => {
    expect(wrappedKinds(repoConfig, "nodejs")).toEqual([]);
  });

  it("keeps client source maps off and the other Sentry build options", () => {
    expect(repoConfig.productionBrowserSourceMaps).toBe(false);
    expect(repoConfig.output).toBeUndefined();
  });

  it("control: the old top-level nesting still wraps edge route handlers (so the check above is real)", () => {
    const oldNesting = withSentryConfig({ reactStrictMode: true }, {
      silent: true,
      autoInstrumentServerFunctions: false,
      autoInstrumentMiddleware: false,
      autoInstrumentAppDirectory: false,
    } as Parameters<typeof withSentryConfig>[1]) as unknown as NextCfg;
    expect(wrappedKinds(oldNesting, "edge")).toContain('"wrappingTargetKind":"route-handler"');
  });
});
