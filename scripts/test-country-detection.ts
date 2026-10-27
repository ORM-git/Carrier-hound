/**
 * scripts/test-country-detection.ts
 *
 * Comprehensive offline unit test suite for detectCountryCode in scripts/utils/sanitizer.ts.
 * Validates:
 * 1. Positive country resolution:
 *    - "Remote - <country>" format
 *    - "<City>, <Country>" format
 *    - City, state/province names and postal codes (US & Canada)
 *    - Common country aliases and demonyms
 *    - ATS country field inputs (strings and objects)
 * 2. Strict trap handling:
 *    - Trap 1: India vs Indiana
 *    - Trap 2: Mexico vs New Mexico
 *    - Trap 3: Georgia state vs Georgia country vs standalone Georgia
 *    - Trap 4: New Jersey vs Jersey Channel Island vs standalone Jersey
 *    - Trap 5: Guinea vs Papua New Guinea vs Equatorial Guinea vs Guinea-Bissau
 *    - Trap 6: Kansas vs Arkansas vs Kansas City
 * 3. Ambiguous and multi-region handling (strictly returns null):
 *    - Remote, Worldwide, Global, Anywhere, Hybrid, Distributed
 *    - EMEA, APAC, LATAM, Americas, Europe
 *    - Multi-country strings ("US or Canada", "US / UK", "London or New York")
 *    - Conflicting location vs ATS field
 * 4. Negative control mode:
 *    - Flag --negative-control executes a deliberate invalid assertion and exits non-zero.
 */

import * as assert from 'assert';
import { detectCountryCode, COUNTRY_MAP, ISO_ALPHA2_CODES } from './utils/sanitizer';

const isNegativeControl = process.argv.includes('--negative-control');

async function runTestSuite() {
  console.log('================================================================================');
  console.log('        COUNTRY DETECTION OFFLINE UNIT TEST SUITE [PASS-LOCAL]                 ');
  console.log('================================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (asserting Indiana maps to IN)...\n');
    const result = detectCountryCode('Indianapolis, Indiana');
    assert.strictEqual(
      result,
      'IN',
      'Negative control expected failure: Indiana must NEVER map to IN (India)!'
    );
    return;
  }

  let passed = 0;
  let failed = 0;

  function testCase(
    desc: string,
    actual: string | null,
    expected: string | null
  ) {
    if (actual === expected) {
      console.log(`  ✅ [PASS] ${desc} -> ${JSON.stringify(actual)}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${desc} -> Got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Positive "Remote - <Country>" Cases
  // ---------------------------------------------------------------------------
  console.log('--- Test 1: Positive "Remote - <Country>" Formats ---');
  testCase('Remote - United States', detectCountryCode('Remote - United States'), 'US');
  testCase('Remote - India', detectCountryCode('Remote - India'), 'IN');
  testCase('Remote - Germany', detectCountryCode('Remote - Germany'), 'DE');
  testCase('Remote - Canada', detectCountryCode('Remote - Canada'), 'CA');
  testCase('Remote - United Kingdom', detectCountryCode('Remote - United Kingdom'), 'GB');
  testCase('Remote - UK', detectCountryCode('Remote - UK'), 'GB');
  testCase('Remote - France', detectCountryCode('Remote - France'), 'FR');
  testCase('Remote - Brazil', detectCountryCode('Remote - Brazil'), 'BR');
  testCase('Remote - Japan', detectCountryCode('Remote - Japan'), 'JP');
  testCase('Remote - Australia', detectCountryCode('Remote - Australia'), 'AU');
  testCase('Remote: Netherlands', detectCountryCode('Remote: Netherlands'), 'NL');
  testCase('Remote - Singapore', detectCountryCode('Remote - Singapore'), 'SG');

  // ---------------------------------------------------------------------------
  // 2. Positive "<City>, <Country>" Formats
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 2: Positive "<City>, <Country>" Formats ---');
  testCase('Berlin, Germany', detectCountryCode('Berlin, Germany'), 'DE');
  testCase('Toronto, Canada', detectCountryCode('Toronto, Canada'), 'CA');
  testCase('London, United Kingdom', detectCountryCode('London, United Kingdom'), 'GB');
  testCase('Paris, France', detectCountryCode('Paris, France'), 'FR');
  testCase('Tokyo, Japan', detectCountryCode('Tokyo, Japan'), 'JP');
  testCase('Sydney, Australia', detectCountryCode('Sydney, Australia'), 'AU');
  testCase('Amsterdam, Netherlands', detectCountryCode('Amsterdam, Netherlands'), 'NL');
  testCase('Dublin, Ireland', detectCountryCode('Dublin, Ireland'), 'IE');
  testCase('Zurich, Switzerland', detectCountryCode('Zurich, Switzerland'), 'CH');
  testCase('Stockholm, Sweden', detectCountryCode('Stockholm, Sweden'), 'SE');
  testCase('Madrid, Spain', detectCountryCode('Madrid, Spain'), 'ES');
  testCase('Rome, Italy', detectCountryCode('Rome, Italy'), 'IT');
  testCase('Warsaw, Poland', detectCountryCode('Warsaw, Poland'), 'PL');
  testCase('Tel Aviv, Israel', detectCountryCode('Tel Aviv, Israel'), 'IL');

  // ---------------------------------------------------------------------------
  // 3. Positive City, State/Province Names and Codes
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 3: City, State/Province Names and Codes ---');
  testCase('San Francisco, CA', detectCountryCode('San Francisco, CA'), 'US');
  testCase('Austin, TX', detectCountryCode('Austin, TX'), 'US');
  testCase('Seattle, Washington', detectCountryCode('Seattle, Washington'), 'US');
  testCase('New York, NY', detectCountryCode('New York, NY'), 'US');
  testCase('Chicago, Illinois', detectCountryCode('Chicago, Illinois'), 'US');
  testCase('Denver, Colorado', detectCountryCode('Denver, Colorado'), 'US');
  testCase('Boston, MA', detectCountryCode('Boston, MA'), 'US');
  testCase('Vancouver, BC', detectCountryCode('Vancouver, BC'), 'CA');
  testCase('Toronto, ON', detectCountryCode('Toronto, ON'), 'CA');
  testCase('Montreal, Quebec', detectCountryCode('Montreal, Quebec'), 'CA');
  testCase('Multiple US cities: New York, Seattle, San Francisco', detectCountryCode('New York, Seattle, San Francisco'), 'US');

  // ---------------------------------------------------------------------------
  // 4. Common Country Aliases & Demonyms
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 4: Common Country Aliases & Demonyms ---');
  testCase('United States of America', detectCountryCode('United States of America'), 'US');
  testCase('USA', detectCountryCode('USA'), 'US');
  testCase('Great Britain', detectCountryCode('Great Britain'), 'GB');
  testCase('England', detectCountryCode('England'), 'GB');
  testCase('Scotland', detectCountryCode('Scotland'), 'GB');
  testCase('Deutschland', detectCountryCode('Deutschland'), 'DE');
  testCase('The Netherlands', detectCountryCode('The Netherlands'), 'NL');
  testCase('Holland', detectCountryCode('Holland'), 'NL');
  testCase('United Arab Emirates', detectCountryCode('United Arab Emirates'), 'AE');
  testCase('UAE', detectCountryCode('UAE'), 'AE');
  testCase('Dubai, UAE', detectCountryCode('Dubai, UAE'), 'AE');
  testCase('South Korea', detectCountryCode('South Korea'), 'KR');
  testCase('Czech Republic', detectCountryCode('Czech Republic'), 'CZ');

  // ---------------------------------------------------------------------------
  // 5. ATS Field Integration
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 5: ATS Field Integration ---');
  testCase('ATS string country: "United States"', detectCountryCode('Hybrid', 'United States'), 'US');
  testCase('ATS ISO code string: "CA"', detectCountryCode('Remote', 'CA'), 'CA');
  testCase('ATS object with country: { country: "Germany" }', detectCountryCode('Hybrid', { country: 'Germany' }), 'DE');
  testCase('ATS object with countryCode: { countryCode: "IN" }', detectCountryCode('In-Office', { countryCode: 'IN' }), 'IN');
  testCase('ATS object country fallback: { country: "France" }', detectCountryCode('', { country: 'France' }), 'FR');
  testCase('Location concrete overrides empty ATS', detectCountryCode('Paris, France', ''), 'FR');
  testCase('Matching ATS and location: "US"', detectCountryCode('San Francisco, CA', 'United States'), 'US');

  // ---------------------------------------------------------------------------
  // 6. Safe Traps: Trap 1 - India vs Indiana
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 6: Trap 1 - India vs Indiana ---');
  testCase('Indianapolis, Indiana -> US', detectCountryCode('Indianapolis, Indiana'), 'US');
  testCase('Fort Wayne, IN -> US', detectCountryCode('Fort Wayne, IN'), 'US');
  testCase('Indiana, US -> US', detectCountryCode('Indiana, US'), 'US');
  testCase('Indiana -> US', detectCountryCode('Indiana'), 'US');
  testCase('Mumbai, India -> IN', detectCountryCode('Mumbai, India'), 'IN');
  testCase('Bengaluru, Karnataka, India -> IN', detectCountryCode('Bengaluru, Karnataka, India'), 'IN');
  testCase('India -> IN', detectCountryCode('India'), 'IN');
  testCase('Standalone "IN" -> null (ambiguous)', detectCountryCode('IN'), null);
  testCase('Standalone "Remote - IN" -> null (ambiguous)', detectCountryCode('Remote - IN'), null);

  // ---------------------------------------------------------------------------
  // 7. Safe Traps: Trap 2 - Mexico vs New Mexico
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 7: Trap 2 - Mexico vs New Mexico ---');
  testCase('Albuquerque, New Mexico -> US', detectCountryCode('Albuquerque, New Mexico'), 'US');
  testCase('Santa Fe, NM -> US', detectCountryCode('Santa Fe, NM'), 'US');
  testCase('New Mexico, USA -> US', detectCountryCode('New Mexico, USA'), 'US');
  testCase('New Mexico -> US', detectCountryCode('New Mexico'), 'US');
  testCase('Mexico City, Mexico -> MX', detectCountryCode('Mexico City, Mexico'), 'MX');
  testCase('Guadalajara, Jalisco, Mexico -> MX', detectCountryCode('Guadalajara, Jalisco, Mexico'), 'MX');
  testCase('Mexico -> MX', detectCountryCode('Mexico'), 'MX');
  testCase('Remote - Mexico -> MX', detectCountryCode('Remote - Mexico'), 'MX');

  // ---------------------------------------------------------------------------
  // 8. Safe Traps: Trap 3 - Georgia State vs Country
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 8: Trap 3 - Georgia State vs Country ---');
  testCase('Atlanta, GA -> US', detectCountryCode('Atlanta, GA'), 'US');
  testCase('Atlanta, Georgia -> US', detectCountryCode('Atlanta, Georgia'), 'US');
  testCase('Savannah, Georgia, US -> US', detectCountryCode('Savannah, Georgia, US'), 'US');
  testCase('Georgia, USA -> US', detectCountryCode('Georgia, USA'), 'US');
  testCase('Tbilisi, Georgia -> GE', detectCountryCode('Tbilisi, Georgia'), 'GE');
  testCase('Batumi, Georgia -> GE', detectCountryCode('Batumi, Georgia'), 'GE');
  testCase('Georgia (country) -> GE', detectCountryCode('Georgia (country)'), 'GE');
  testCase('Country of Georgia -> GE', detectCountryCode('Country of Georgia'), 'GE');
  testCase('Standalone "Georgia" -> null (ambiguous)', detectCountryCode('Georgia'), null);
  testCase('Standalone "Remote - Georgia" -> null (ambiguous)', detectCountryCode('Remote - Georgia'), null);
  testCase('Athens, Greece -> GR', detectCountryCode('Athens, Greece'), 'GR');
  testCase('Athens, GR -> GR', detectCountryCode('Athens, GR'), 'GR');
  testCase('bare "Athens" -> null', detectCountryCode('Athens'), null);
  testCase('Athens, GA -> US', detectCountryCode('Athens, GA'), 'US');
  testCase('Athens, Georgia -> US', detectCountryCode('Athens, Georgia'), 'US');

  // ---------------------------------------------------------------------------
  // 9. Safe Traps: Trap 4 - New Jersey vs Jersey Channel Island
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 9: Trap 4 - New Jersey vs Jersey Channel Island ---');
  testCase('Jersey City, NJ -> US', detectCountryCode('Jersey City, NJ'), 'US');
  testCase('Newark, New Jersey -> US', detectCountryCode('Newark, New Jersey'), 'US');
  testCase('New Jersey, US -> US', detectCountryCode('New Jersey, US'), 'US');
  testCase('New Jersey -> US', detectCountryCode('New Jersey'), 'US');
  testCase('Saint Helier, Jersey -> JE', detectCountryCode('Saint Helier, Jersey'), 'JE');
  testCase('Jersey, Channel Islands -> JE', detectCountryCode('Jersey, Channel Islands'), 'JE');
  testCase('Jersey, UK -> JE', detectCountryCode('Jersey, UK'), 'JE');
  testCase('Standalone "Jersey" -> null (ambiguous)', detectCountryCode('Jersey'), null);
  testCase('Standalone "Remote - Jersey" -> null (ambiguous)', detectCountryCode('Remote - Jersey'), null);

  // ---------------------------------------------------------------------------
  // 10. Safe Traps: Trap 5 - Guinea vs New Guinea vs Equatorial Guinea vs Guinea-Bissau
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 10: Trap 5 - Guinea Variants ---');
  testCase('Port Moresby, Papua New Guinea -> PG', detectCountryCode('Port Moresby, Papua New Guinea'), 'PG');
  testCase('Papua New Guinea -> PG', detectCountryCode('Papua New Guinea'), 'PG');
  testCase('New Guinea -> PG', detectCountryCode('New Guinea'), 'PG');
  testCase('Malabo, Equatorial Guinea -> GQ', detectCountryCode('Malabo, Equatorial Guinea'), 'GQ');
  testCase('Equatorial Guinea -> GQ', detectCountryCode('Equatorial Guinea'), 'GQ');
  testCase('Bissau, Guinea-Bissau -> GW', detectCountryCode('Bissau, Guinea-Bissau'), 'GW');
  testCase('Guinea-Bissau -> GW', detectCountryCode('Guinea-Bissau'), 'GW');
  testCase('Conakry, Guinea -> GN', detectCountryCode('Conakry, Guinea'), 'GN');
  testCase('Guinea -> GN', detectCountryCode('Guinea'), 'GN');
  testCase('Republic of Guinea -> GN', detectCountryCode('Republic of Guinea'), 'GN');

  // ---------------------------------------------------------------------------
  // 11. Safe Traps: Trap 6 - Kansas vs Kansas-like Names
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 11: Trap 6 - Kansas vs Kansas-like Names ---');
  testCase('Little Rock, Arkansas -> US', detectCountryCode('Little Rock, Arkansas'), 'US');
  testCase('Arkansas, USA -> US', detectCountryCode('Arkansas, USA'), 'US');
  testCase('Arkansas -> US', detectCountryCode('Arkansas'), 'US');
  testCase('Wichita, Kansas -> US', detectCountryCode('Wichita, Kansas'), 'US');
  testCase('Kansas, USA -> US', detectCountryCode('Kansas, USA'), 'US');
  testCase('Kansas -> US', detectCountryCode('Kansas'), 'US');
  testCase('Kansas City -> US', detectCountryCode('Kansas City'), 'US');
  testCase('Kansas City, MO -> US', detectCountryCode('Kansas City, MO'), 'US');

  // ---------------------------------------------------------------------------
  // 12. Ambiguous & Broad Multi-Region Cases (Must Stay null)
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 12: Ambiguous & Broad Regions (Strictly Null) ---');
  testCase('Remote -> null', detectCountryCode('Remote'), null);
  testCase('Worldwide -> null', detectCountryCode('Worldwide'), null);
  testCase('Global -> null', detectCountryCode('Global'), null);
  testCase('Anywhere -> null', detectCountryCode('Anywhere'), null);
  testCase('Work from anywhere -> null', detectCountryCode('Work from anywhere'), null);
  testCase('Distributed -> null', detectCountryCode('Distributed'), null);
  testCase('Hybrid -> null', detectCountryCode('Hybrid'), null);
  testCase('In-Office -> null', detectCountryCode('In-Office'), null);
  testCase('EMEA -> null', detectCountryCode('EMEA'), null);
  testCase('APAC -> null', detectCountryCode('APAC'), null);
  testCase('LATAM -> null', detectCountryCode('LATAM'), null);
  testCase('Americas -> null', detectCountryCode('Americas'), null);
  testCase('Europe -> null', detectCountryCode('Europe'), null);
  testCase('Remote - EMEA -> null', detectCountryCode('Remote - EMEA'), null);
  testCase('US or Canada -> null', detectCountryCode('US or Canada'), null);
  testCase('US / UK -> null', detectCountryCode('US / UK'), null);
  testCase('London or New York -> null', detectCountryCode('London or New York'), null);
  testCase('Conflicting ATS vs Location -> null', detectCountryCode('London, UK', 'United States'), null);
  testCase('Standalone "DE" -> null (ambiguous)', detectCountryCode('DE'), null);
  testCase('Standalone "Remote - DE" -> null (ambiguous)', detectCountryCode('Remote - DE'), null);
  testCase('Standalone "CA" -> null (ambiguous)', detectCountryCode('CA'), null);
  testCase('Standalone "Remote - CA" -> null (ambiguous)', detectCountryCode('Remote - CA'), null);
  testCase('Wilmington, DE -> US', detectCountryCode('Wilmington, DE'), 'US');

  console.log(`\n================================================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions.`);
  console.log(`================================================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
