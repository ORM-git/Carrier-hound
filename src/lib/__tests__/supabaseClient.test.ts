import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "../supabase/client";

describe("supabase/client", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    delete (globalThis as any).__mockSupabaseClient;
  });

  afterEach(() => {
    if (originalUrl !== undefined) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    } else {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
    if (originalKey !== undefined) {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
    } else {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    }
    delete (globalThis as any).__mockSupabaseClient;
  });

  it("returns __mockSupabaseClient in test environment when configured", () => {
    const mock = { custom: "client" };
    (globalThis as any).__mockSupabaseClient = mock;
    expect(createClient()).toBe(mock);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    expect(() => createClient()).toThrow(/Missing Supabase environment variables/);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => createClient()).toThrow(/Missing Supabase environment variables/);
  });

  it("creates client instance when environment variables are set", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    const client = createClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });
});
