/**
 * src/lib/auth/approval.ts
 *
 * Centralized server-side invite-only early-access approval verification.
 * Enforces access control server-side for all authenticated API routes and data access
 * on the live Cloudflare static export where Next.js middleware does not execute.
 *
 * Rules:
 * 1. Checks EARLY_ACCESS_ALLOWED_EMAILS allowlist (no DB hit).
 * 2. Checks if user is verified administrator (isVerifiedAdminUser).
 * 3. Short in-memory cache (60s TTL) around approval verdicts.
 * 4. Queries public.early_access_approved table strictly with select calls.
 */

import { isVerifiedAdminUser } from "../admin/constants";

export interface ApprovalCacheEntry {
  approved: boolean;
  cachedAt: number;
}

const approvalCache = new Map<string, ApprovalCacheEntry>();
const APPROVAL_CACHE_TTL_MS = 60 * 1000;

export function _clearApprovalCacheForTesting(): void {
  approvalCache.clear();
}

export function invalidateApprovalCache(email?: string): void {
  if (!email) {
    approvalCache.clear();
    return;
  }
  approvalCache.delete(email.trim().toLowerCase());
}

export function setApprovalCache(email: string, approved: boolean): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  approvalCache.set(normalized, { approved, cachedAt: Date.now() });
}

export function getAllowedEarlyAccessEmails(): Set<string> {
  const raw = process.env.EARLY_ACCESS_ALLOWED_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Checks whether an authenticated user is approved for platform access.
 * Returns true if approved, false if unapproved or unauthenticated.
 */
export async function isUserApproved(
  supabaseAdmin: any,
  user: { id?: string; email?: string; [key: string]: any } | null | undefined
): Promise<boolean> {
  if (!user || !user.email) {
    return false;
  }

  const normalized = String(user.email).trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return false;
  }

  // 1. Respect EARLY_ACCESS_ALLOWED_EMAILS allowlist first
  if (getAllowedEarlyAccessEmails().has(normalized)) {
    return true;
  }

  // 2. Verified admin user check
  try {
    if (isVerifiedAdminUser(user)) {
      return true;
    }
  } catch {}

  const now = Date.now();
  const cached = approvalCache.get(normalized);

  // 3. Fresh in-memory TTL cache hit (within 60s)
  if (cached && now - cached.cachedAt < APPROVAL_CACHE_TTL_MS) {
    return cached.approved;
  }

  // 4. Query early_access_approved table strictly via select
  try {
    const client =
      (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient) ||
      supabaseAdmin;

    if (!client || typeof client.from !== "function") {
      return false;
    }

    const { data, error } = await client
      .from("early_access_approved")
      .select("approved")
      .eq("email", normalized)
      .maybeSingle();

    if (error) {
      // In case of query error, serve cached approved verdict if within grace
      if (cached && cached.approved) {
        return true;
      }
      return false;
    }

    const approved = data?.approved === true;
    approvalCache.set(normalized, { approved, cachedAt: now });
    return approved;
  } catch {
    if (cached && cached.approved) {
      return true;
    }
    return false;
  }
}
