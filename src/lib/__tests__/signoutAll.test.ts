import { describe, it, expect } from "vitest";
import { handleSignoutAllRequest, SIGNOUT_ALL_RATE_LIMIT } from "@/lib/account/signoutAllHandler";

// Backend sheet rank 74 (Session Revocation): self-serve log-out-everywhere
// revokes all of the caller's sessions with admin scope "global".

function req(token?: string) {
  return new Request("https://example.com/api/account/signout-all", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function fakeAdmin(opts: { user?: any; getUserError?: any; signOutError?: any; calls?: any[] }) {
  const calls = opts.calls || [];
  return {
    calls,
    client: {
      auth: {
        getUser: async (jwt: string) => {
          calls.push({ fn: "getUser", jwt });
          return { data: { user: opts.getUserError ? null : opts.user }, error: opts.getUserError || null };
        },
        admin: {
          signOut: async (jwt: string, scope: string) => {
            calls.push({ fn: "signOut", jwt, scope });
            return { data: null, error: opts.signOutError || null };
          },
        },
      },
    },
  };
}

const allowAll = async () => ({ allowed: true, retryAfter: 0, currentCount: 1, source: "shared" as const });

describe("handleSignoutAllRequest", () => {
  it("rejects requests without a Bearer token", async () => {
    const res = await handleSignoutAllRequest(req(), { getSupabaseAdmin: () => fakeAdmin({}).client, checkLimit: allowAll });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid or expired session", async () => {
    const { client } = fakeAdmin({ getUserError: new Error("bad token") });
    const res = await handleSignoutAllRequest(req("tok"), { getSupabaseAdmin: () => client, checkLimit: allowAll });
    expect(res.status).toBe(401);
  });

  it("revokes ALL sessions with scope global using the caller's own JWT", async () => {
    const { client, calls } = fakeAdmin({ user: { id: "u1" } });
    const res = await handleSignoutAllRequest(req("user-jwt-abc"), { getSupabaseAdmin: () => client, checkLimit: allowAll });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    const so = calls.find((c) => c.fn === "signOut");
    expect(so).toEqual({ fn: "signOut", jwt: "user-jwt-abc", scope: "global" });
  });

  it("rate limits per user before revoking", async () => {
    const { client, calls } = fakeAdmin({ user: { id: "u2" } });
    const deny = async () => ({ allowed: false, retryAfter: 42, currentCount: 6, source: "shared" as const });
    const res = await handleSignoutAllRequest(req("tok2"), { getSupabaseAdmin: () => client, checkLimit: deny });
    expect(res.status).toBe(429);
    expect(calls.find((c) => c.fn === "signOut")).toBeUndefined();
  });

  it("returns 500 when the admin sign-out call fails", async () => {
    const { client } = fakeAdmin({ user: { id: "u3" }, signOutError: new Error("down") });
    const res = await handleSignoutAllRequest(req("tok3"), { getSupabaseAdmin: () => client, checkLimit: allowAll });
    expect(res.status).toBe(500);
  });

  it("documents a conservative rate limit", () => {
    expect(SIGNOUT_ALL_RATE_LIMIT.maxRequests).toBeLessThanOrEqual(10);
    expect(SIGNOUT_ALL_RATE_LIMIT.windowSeconds).toBeGreaterThanOrEqual(600);
  });
});
