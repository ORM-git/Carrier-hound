import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guard for DB sheet rank 72 (select-star narrowing), billing-critical reads.
// Each case pins a narrowed .select() list to the exact set of row fields the
// surrounding code reads, so a narrowed billing read can never silently drop a
// field the entitlement/period/quota logic consumes (or carry an unused one).

const ROOT = join(__dirname, "..", "..", "..");

interface Case {
  label: string;
  selectFile: string;
  selectStart: string;
  selectEnd: string;
  table: string;
  readFile: string;
  readStart: string;
  readEnd: string;
  vars: string[];
}

const CASES: Case[] = [
  {
    label: "quota.ts subscriptions",
    selectFile: "src/lib/billing/quota.ts",
    selectStart: "export async function getPlanQuota",
    selectEnd: '.from("plans")',
    table: "subscriptions",
    readFile: "src/lib/billing/quota.ts",
    readStart: "export async function getPlanQuota",
    readEnd: "// 5. Query plan usage events",
    vars: ["sub"],
  },
  {
    label: "quota.ts plans",
    selectFile: "src/lib/billing/quota.ts",
    selectStart: '.from("plans")',
    selectEnd: "PLAN_DEFINITIONS",
    table: "plans",
    readFile: "src/lib/billing/quota.ts",
    readStart: '.from("plans")',
    readEnd: "Fallback cleanly",
    vars: ["dbPlan"],
  },
  {
    label: "subscription.ts retry read",
    selectFile: "src/lib/billing/subscription.ts",
    selectStart: "async function querySubscriptionWithRetry",
    selectEnd: "export async function getProAccessStatus",
    table: "subscriptions",
    readFile: "src/lib/billing/subscription.ts",
    readStart: "export async function getProAccessStatus",
    readEnd: "export function setLocalProActive",
    vars: ["sub"],
  },
  {
    label: "subscription.ts getUserSubscription",
    selectFile: "src/lib/billing/subscription.ts",
    selectStart: "export async function getUserSubscription",
    selectEnd: "export async function cancelSubscription",
    table: "subscriptions",
    readFile: "src/lib/billing/subscription.ts",
    readStart: "export async function getUserSubscription",
    readEnd: "export async function cancelSubscription",
    vars: ["sub"],
  },
  {
    label: "serverEntitlement.ts",
    selectFile: "src/lib/billing/serverEntitlement.ts",
    selectStart: "export async function getServerEntitlement",
    selectEnd: "catch (err)",
    table: "subscriptions",
    readFile: "src/lib/billing/serverEntitlement.ts",
    readStart: "export async function getServerEntitlement",
    readEnd: "catch (err)",
    vars: ["sub"],
  },
  {
    label: "verify route order lookup",
    selectFile: "src/app/api/billing/razorpay/verify/route.ts",
    selectStart: "// Look up order in payment_orders table",
    selectEnd: "if (orderErr || !orderRow)",
    table: "payment_orders",
    readFile: "src/app/api/billing/razorpay/verify/route.ts",
    readStart: "if (orderErr || !orderRow)",
    readEnd: "// Fulfillment happens only through the atomic SQL RPC fulfil_payment_order",
    vars: ["orderRow"],
  },
];

function windowOf(file: string, start: string, end: string): string {
  const src = readFileSync(join(ROOT, file), "utf8");
  const a = src.indexOf(start);
  expect(a, `${file}: start marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(end, a + start.length);
  expect(b, `${file}: end marker not found: ${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("billing narrowed select lists (DB sheet rank 72)", () => {
  CASES.forEach((c) => {
    it(`${c.label}: select list equals the fields the code reads`, () => {
      const selWin = windowOf(c.selectFile, c.selectStart, c.selectEnd);
      const re = new RegExp('\\.from\\("' + c.table + '"\\)\\s*\\.select\\("([^"]+)"\\)');
      const m = re.exec(selWin);
      expect(m, `${c.label}: named select list not found (still select("*")?)`).not.toBeNull();
      const selected = (m as RegExpExecArray)[1].split(",").map((x) => x.trim()).sort();

      const readWin = windowOf(c.readFile, c.readStart, c.readEnd);
      const read: string[] = [];
      c.vars.forEach((v) => {
        const rr = new RegExp("\\b" + v + "\\??\\.([a-z_]+)", "g");
        let r: RegExpExecArray | null;
        while ((r = rr.exec(readWin)) !== null) {
          if (read.indexOf(r[1]) === -1) read.push(r[1]);
        }
      });
      expect(selected, `${c.label}: select list must equal the fields read`).toEqual(read.sort());
    });
  });

  it("verify route uses RPC-only fulfilment with zero JS grant writes to subscriptions or credits", () => {
    const src = readFileSync(join(ROOT, "src/app/api/billing/razorpay/verify/route.ts"), "utf8");
    expect(src).toContain('supabaseAdmin.rpc("fulfil_payment_order"');
    expect(src).not.toContain('.from("subscriptions")');
    expect(src).not.toContain('.from("user_addon_credits")');
    expect(src).not.toContain('.update({ status: "paid"');
  });

  it("migration 20261113a enforces strict ACL revoking from public, anon, and authenticated and granting only service_role", () => {
    const migPath = join(ROOT, "supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql");
    const content = readFileSync(migPath, "utf8");
    expect(content).toContain("REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;");
    expect(content).toContain("REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM anon;");
    expect(content).toContain("REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM authenticated;");
    expect(content).toContain("GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;");

    const grantLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^GRANT\s+/i.test(l));
    expect(grantLines).toEqual(["GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;"]);
  });
});
