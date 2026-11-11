/**
 * Offline test for AI Provider Abstraction Layer (Backend sheet row "Provider Abstraction Layer").
 *
 * Verifies that the server-side provider adapter interface (AiTextCompletionProviderAdapter),
 * default Groq implementation, error categorization (network, http_status, invalid_json),
 * and provider swap seams function correctly without making live external API calls.
 *
 * Run: npx tsx scripts/test-ai-provider-abstraction.ts
 * Negative control: npx tsx scripts/test-ai-provider-abstraction.ts --negative-control
 */

import * as fs from "fs";
import {
  groqTextCompletionAdapter,
  createGroqTextCompletionAdapter,
  createMockTextCompletionAdapter,
  buildGroqChatCompletionBody,
  extractTextCompletionContent,
  AiProviderUpstreamError,
  AiTextCompletionRequest,
} from "../src/lib/ai/providerAdapter";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("Running negative control check...");
    check("negative control: forced assertion failure", false);
    process.exit(1);
  }

  // 1. Default adapter contract
  check("default adapter provider is groq", groqTextCompletionAdapter.provider === "groq");
  check("default adapter has completeText method", typeof groqTextCompletionAdapter.completeText === "function");

  // 2. Request body builder
  const reqNonJson: AiTextCompletionRequest = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "Write a cover letter" }],
    maxOutputTokens: 1024,
    temperature: 0.7,
    jsonMode: false,
  };
  const bodyNonJson = buildGroqChatCompletionBody(reqNonJson);
  check("non-json request body model matches", bodyNonJson.model === "llama-3.3-70b-versatile");
  check("non-json request body max_tokens matches", bodyNonJson.max_tokens === 1024);
  check("non-json request body temperature matches", bodyNonJson.temperature === 0.7);
  check("non-json request omits response_format", bodyNonJson.response_format === undefined);

  const reqJson: AiTextCompletionRequest = {
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: "Extract resume data" }],
    maxOutputTokens: 2048,
    temperature: 0.2,
    jsonMode: true,
  };
  const bodyJson = buildGroqChatCompletionBody(reqJson);
  check(
    "json request sets response_format to json_object",
    (bodyJson.response_format as any)?.type === "json_object"
  );

  // 3. Content extraction helper
  check(
    "extracts content from choices[0].message.content",
    extractTextCompletionContent({
      choices: [{ message: { content: "Extracted choice content" } }],
    }) === "Extracted choice content"
  );
  check(
    "extracts content from top-level content property",
    extractTextCompletionContent({ content: "Top-level content" }) === "Top-level content"
  );
  check(
    "extracts content from top-level result property",
    extractTextCompletionContent({ result: "Top-level result" }) === "Top-level result"
  );
  check(
    "extracts direct string content",
    extractTextCompletionContent("Direct string text") === "Direct string text"
  );
  check("returns undefined for empty object", extractTextCompletionContent({}) === undefined);
  check("returns undefined for null", extractTextCompletionContent(null) === undefined);

  // 4. Error mapping: Network error
  const networkFailingAdapter = createGroqTextCompletionAdapter({
    fetchImpl: async () => {
      throw new Error("DNS resolution failed");
    },
  });
  try {
    await networkFailingAdapter.completeText(reqNonJson);
    check("throws on network failure", false);
  } catch (err: any) {
    check("throws AiProviderUpstreamError on network failure", err instanceof AiProviderUpstreamError);
    check("network error kind is 'network'", err.kind === "network");
  }

  // 5. Error mapping: HTTP status error (e.g. 429)
  const httpFailingAdapter = createGroqTextCompletionAdapter({
    fetchImpl: async () => {
      return new Response(JSON.stringify({ error: "rate limit" }), {
        status: 429,
        statusText: "Too Many Requests",
      });
    },
  });
  try {
    await httpFailingAdapter.completeText(reqNonJson);
    check("throws on http error", false);
  } catch (err: any) {
    check("throws AiProviderUpstreamError on http error", err instanceof AiProviderUpstreamError);
    check("http error kind is 'http_status'", err.kind === "http_status");
    check("http error captures status code 429", err.status === 429);
  }

  // 6. Error mapping: Invalid JSON response
  const invalidJsonAdapter = createGroqTextCompletionAdapter({
    fetchImpl: async () => {
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  try {
    await invalidJsonAdapter.completeText(reqNonJson);
    check("throws on invalid json", false);
  } catch (err: any) {
    check("throws AiProviderUpstreamError on invalid json", err instanceof AiProviderUpstreamError);
    check("invalid json error kind is 'invalid_json'", err.kind === "invalid_json");
  }

  // 7. Successful completion with custom fetchImpl
  let capturedAuthHeader: string | null = null;
  const successfulAdapter = createGroqTextCompletionAdapter({
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      capturedAuthHeader = headers.get("Authorization");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Valid mock completion" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  const successRes = (await successfulAdapter.completeText(reqNonJson, {
    apiKey: "test-api-key-123",
  })) as any;
  check("successful adapter returns choices", successRes.choices[0].message.content === "Valid mock completion");
  check("successful adapter passes Authorization Bearer header", capturedAuthHeader === "Bearer test-api-key-123");
  check("usage stats are returned", successRes.usage.total_tokens === 30);

  // 8. Swap seam: Mock provider adapter
  const mockProvider = createMockTextCompletionAdapter("mock-claude", { tailored: true });
  check("mock adapter provider identifier", mockProvider.provider === "mock-claude");
  const mockRes = (await mockProvider.completeText(reqJson)) as any;
  check("mock adapter returns serialized content", mockRes.choices[0].message.content === '{"tailored":true}');
  check("mock adapter returns usage structure", mockRes.usage.total_tokens === 40);

  // 9. Static code wiring checks
  const serviceHandlerCode = fs.readFileSync("src/lib/ai/serviceHandler.ts", "utf8");
  check(
    "serviceHandler defines providerAdapter in AiServiceDeps",
    /providerAdapter\?:\s*AiTextCompletionProviderAdapter/.test(serviceHandlerCode)
  );
  check(
    "serviceHandler uses activeDeps.providerAdapter with fallback to groqTextCompletionAdapter",
    /activeDeps\.providerAdapter\s*\?\?\s*groqTextCompletionAdapter/.test(serviceHandlerCode)
  );

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
