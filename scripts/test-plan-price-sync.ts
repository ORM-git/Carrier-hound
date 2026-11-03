import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { PLANS, ADD_ON_PACKS } from "../src/config/plans";
import { PLAN_DEFINITIONS, ADDON_PACK_DEFINITIONS } from "../src/lib/billing/quota";

async function runPlanPriceSyncSuite() {
  console.log("================================================================================");
  console.log("   PLAN & ADD-ON PRICE SYNC REGRESSION TEST SUITE [PASS-LOCAL]                 ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid divergence...");
    // Assert invalid condition to guarantee non-zero exit code
    assert.strictEqual(
      PLANS[0].price * 100,
      999999,
      "Negative control expected mismatch: weekly price * 100 is not 999999!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: plans.ts (price * 100) strictly matches quota.ts (price_paise)
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying src/config/plans.ts price * 100 equals PLAN_DEFINITIONS.price_paise...");

  for (const plan of PLANS) {
    const planCode = plan.id as keyof typeof PLAN_DEFINITIONS;
    const quotaDef = PLAN_DEFINITIONS[planCode];
    assert.ok(quotaDef, `PLAN_DEFINITIONS must define plan for code '${plan.id}'`);

    const expectedPaise = plan.price * 100;
    assert.strictEqual(
      expectedPaise,
      quotaDef.price_paise,
      `Price mismatch for plan '${plan.id}': plans.ts (${plan.price} -> ${expectedPaise} paise) !== quota.ts (${quotaDef.price_paise} paise)`
    );
    console.log(`  - Plan '${plan.id}': plans.ts Rs ${plan.price} = quota.ts ${quotaDef.price_paise} paise [OK]`);
  }

  // ---------------------------------------------------------------------------
  // TEST 2: plans.ts ADD_ON_PACKS strictly matches quota.ts ADDON_PACK_DEFINITIONS
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying ADD_ON_PACKS price * 100 equals ADDON_PACK_DEFINITIONS.price_paise...");

  const setsToCodeMap: Record<number, string> = {
    10: "addon_10",
    30: "addon_30",
    60: "addon_60",
  };

  for (const pack of ADD_ON_PACKS) {
    const addonCode = setsToCodeMap[pack.sets];
    assert.ok(addonCode, `Must have mapped addonCode for pack with ${pack.sets} sets`);
    const quotaDef = ADDON_PACK_DEFINITIONS[addonCode];
    assert.ok(quotaDef, `ADDON_PACK_DEFINITIONS must define pack for code '${addonCode}'`);

    const expectedPaise = pack.price * 100;
    assert.strictEqual(
      expectedPaise,
      quotaDef.price_paise,
      `Price mismatch for add-on pack '${addonCode}': plans.ts (${pack.price} -> ${expectedPaise} paise) !== quota.ts (${quotaDef.price_paise} paise)`
    );
    console.log(`  - Add-on '${addonCode}' (${pack.sets} sets): plans.ts Rs ${pack.price} = quota.ts ${quotaDef.price_paise} paise [OK]`);
  }

  // ---------------------------------------------------------------------------
  // TEST 3: DB Migration Seed Values Match config and definitions
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying effective DB migration seed and update values match code constants...");

  const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
  assert.ok(fs.existsSync(migrationsDir), "supabase/migrations directory must exist");

  // Read baseline catalog migration
  const catalogMigrationPath = path.join(migrationsDir, "20261103_plans_addons_usage.sql");
  assert.ok(fs.existsSync(catalogMigrationPath), "20261103_plans_addons_usage.sql must exist");
  const catalogSql = fs.readFileSync(catalogMigrationPath, "utf-8");

  // Track effective migration price states
  const effectivePlanPrices: Record<string, number> = {};
  const effectiveAddonPrices: Record<string, number> = {};

  // Parse baseline plan inserts: ('weekly', 'Weekly', 7, 49900, ...)
  const planInsertRegex = /\('(\w+)',\s*'[^']+',\s*\d+,\s*(\d+),/g;
  let match: RegExpExecArray | null;
  while ((match = planInsertRegex.exec(catalogSql)) !== null) {
    effectivePlanPrices[match[1]] = parseInt(match[2], 10);
  }

  // Parse baseline addon inserts: ('addon_10', 14900, 10), ...
  const addonInsertRegex = /\('(addon_\d+)',\s*(\d+),/g;
  while ((match = addonInsertRegex.exec(catalogSql)) !== null) {
    effectiveAddonPrices[match[1]] = parseInt(match[2], 10);
  }

  // Apply any subsequent price update migrations
  const weeklyPriceMigrationPath = path.join(migrationsDir, "20261103e_weekly_price_692.sql");
  assert.ok(fs.existsSync(weeklyPriceMigrationPath), "20261103e_weekly_price_692.sql must exist");
  const weeklySql = fs.readFileSync(weeklyPriceMigrationPath, "utf-8");

  const updateRegex = /update\s+public\.plans\s+set\s+price_paise\s*=\s*(\d+)\s+where\s+code\s*=\s*'(\w+)';/i;
  const updateMatch = updateRegex.exec(weeklySql);
  assert.ok(updateMatch, "20261103e_weekly_price_692.sql must contain valid update statement");
  effectivePlanPrices[updateMatch[2]] = parseInt(updateMatch[1], 10);

  // Compare effective migration prices to PLAN_DEFINITIONS
  for (const [code, planDef] of Object.entries(PLAN_DEFINITIONS)) {
    const migrationPrice = effectivePlanPrices[code];
    assert.strictEqual(
      planDef.price_paise,
      migrationPrice,
      `Migration seed price mismatch for plan '${code}': code (${planDef.price_paise}) !== migration (${migrationPrice})`
    );
    console.log(`  - Migration effective plan '${code}': ${migrationPrice} paise = PLAN_DEFINITIONS [OK]`);
  }

  // Compare effective migration prices to ADDON_PACK_DEFINITIONS
  for (const [code, addonDef] of Object.entries(ADDON_PACK_DEFINITIONS)) {
    const migrationPrice = effectiveAddonPrices[code];
    assert.strictEqual(
      addonDef.price_paise,
      migrationPrice,
      `Migration seed price mismatch for addon '${code}': code (${addonDef.price_paise}) !== migration (${migrationPrice})`
    );
    console.log(`  - Migration effective addon '${code}': ${migrationPrice} paise = ADDON_PACK_DEFINITIONS [OK]`);
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Negative Control Subprocess Execution
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("   ALL PLAN & ADD-ON PRICE SYNC TESTS PASSED SUCCESSFULLY [PASS-LOCAL]         ");
  console.log("================================================================================");
}

runPlanPriceSyncSuite().catch((err) => {
  console.error("\n[FAIL] Plan Price Sync Suite Error:\n", err);
  process.exit(1);
});
