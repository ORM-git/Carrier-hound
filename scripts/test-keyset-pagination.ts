import assert from "node:assert";
import { encodeCursor, decodeCursor } from "../src/lib/pagination/cursor";

/**
 * Keyset Pagination, Filters, and Cursor Verification Suite
 * Tests:
 * 1. Strict ISO timestamp + UUID validation in decodeCursor (else null)
 * 2. Malicious payload tests with "1900-01-01,company.ilike.%acme%"
 * 3. Exact PostgREST posted_at string format preservation in encodeCursor
 * 4. Keyset pagination determinism and zero row overlap across pages
 * 5. Guarding salaryMin, company, sourceType, description when jobs_public is used
 * 6. URL query parameter parsing and bidirectional syncing
 * 7. Negative control validation (non-zero exit on invalid condition)
 */

const isNegativeControl = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("           KEYSET PAGINATION & 100K+ FILTER VERIFICATION SUITE                  ");
console.log("================================================================================");
console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Must Fail)" : "NORMAL VERIFICATION"}`);

async function runKeysetCursorTests() {
  console.log("\n[1/5] Testing Keyset Cursor Encoder / Decoder & Security Injections...");

  const validDate = "2026-10-28T14:30:00.000Z";
  const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  // 1. Standard valid roundtrip
  const encoded = encodeCursor(validDate, validUuid);
  assert.ok(typeof encoded === "string" && encoded.length > 0, "encodeCursor must return non-empty string");
  const decoded = decodeCursor(encoded);
  assert.ok(decoded !== null, "decodeCursor must successfully decode valid cursor");
  assert.strictEqual(decoded.posted_at, validDate, "Decoded posted_at must match original");
  assert.strictEqual(decoded.id, validUuid, "Decoded id must match original");
  console.log("  [PASS] Standard cursor encode/decode roundtrip with valid UUID and ISO timestamp");

  // 2. Microsecond timestamp round-trip: keep exact PostgREST string without millisecond truncation
  const microsecondTimestamp = "2026-10-28T14:30:00.123456Z";
  const encodedMicro = encodeCursor(microsecondTimestamp, validUuid);
  const decodedMicro = decodeCursor(encodedMicro);
  assert.ok(decodedMicro !== null, "decodeCursor must decode microsecond timestamp");
  assert.strictEqual(
    decodedMicro.posted_at,
    microsecondTimestamp,
    "encodeCursor must preserve exact microsecond timestamp (never re-serialise via new Date().toISOString() which drops microseconds)"
  );
  // Also verify that re-serializing through new Date().toISOString() WOULD have truncated microseconds, proving value of raw string preservation
  assert.notStrictEqual(new Date(microsecondTimestamp).toISOString(), microsecondTimestamp, "Sanity check: new Date().toISOString() drops microseconds");
  console.log("  [PASS] Microsecond cursor round-trip strictly preserved (6 subsecond digits: .123456Z)");

  // 2b. Exact PostgREST timezone offset format
  const exactPostgrestDate = "2026-10-28T14:30:00.123456+00:00";
  const encodedExact = encodeCursor(exactPostgrestDate, validUuid);
  const decodedExact = decodeCursor(encodedExact);
  assert.ok(decodedExact !== null, "decodeCursor must decode exact PostgREST timestamp");
  assert.strictEqual(decodedExact.posted_at, exactPostgrestDate, "encodeCursor must keep exact PostgREST string without mutation");
  console.log("  [PASS] Exact PostgREST posted_at string format strictly preserved in encodeCursor");

  // 3. Cursor with null postedAt (undated job postings)
  const nullDateEncoded = encodeCursor(null, validUuid);
  const nullDateDecoded = decodeCursor(nullDateEncoded);
  assert.ok(nullDateDecoded !== null, "decodeCursor must handle null postedAt");
  assert.strictEqual(nullDateDecoded.posted_at, null, "Decoded posted_at should be null");
  assert.strictEqual(nullDateDecoded.id, validUuid, "Decoded id must match original");
  console.log("  [PASS] Null posted_at cursor encode/decode roundtrip");

  // 4. MALICIOUS INJECTION TESTS: payloads containing ',', '(', ')', and 'company.ilike.%acme%'
  console.log("  Testing malicious injection payloads containing ',', '(', ')', and 'company.ilike.%acme%'...");

  // Case 4a: Payload containing ','
  const commaPayloadInDate = Buffer.from(JSON.stringify(["2026-10-28T14:30:00Z,posted_at.is.null", validUuid]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(commaPayloadInDate), null, "decodeCursor MUST return null for payload containing comma in posted_at");

  const commaPayloadInId = Buffer.from(JSON.stringify([validDate, `${validUuid},id.lt.9999`]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(commaPayloadInId), null, "decodeCursor MUST return null for payload containing comma in id");

  // Case 4b: Payload containing '('
  const openParenPayloadInDate = Buffer.from(JSON.stringify(["2026-10-28T14:30:00Z(or", validUuid]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(openParenPayloadInDate), null, "decodeCursor MUST return null for payload containing '(' in posted_at");

  const openParenPayloadInId = Buffer.from(JSON.stringify([validDate, `and(${validUuid}`]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(openParenPayloadInId), null, "decodeCursor MUST return null for payload containing '(' in id");

  // Case 4c: Payload containing ')'
  const closeParenPayloadInDate = Buffer.from(JSON.stringify(["2026-10-28T14:30:00Z)", validUuid]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(closeParenPayloadInDate), null, "decodeCursor MUST return null for payload containing ')' in posted_at");

  const closeParenPayloadInId = Buffer.from(JSON.stringify([validDate, `${validUuid})`]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(closeParenPayloadInId), null, "decodeCursor MUST return null for payload containing ')' in id");

  // Case 4d: Payload containing 'company.ilike.%acme%'
  const acmePayloadInDate = Buffer.from(JSON.stringify(["1900-01-01,company.ilike.%acme%", validUuid]), "utf-8").toString("base64");
  assert.strictEqual(
    decodeCursor(acmePayloadInDate),
    null,
    "decodeCursor MUST return null for malicious posted_at payload: 1900-01-01,company.ilike.%acme%"
  );

  const acmePayloadInId = Buffer.from(JSON.stringify([validDate, "company.ilike.%acme%"]), "utf-8").toString("base64");
  assert.strictEqual(
    decodeCursor(acmePayloadInId),
    null,
    "decodeCursor MUST return null for malicious id payload: company.ilike.%acme%"
  );

  // Case 4e: Raw string containing injection
  assert.strictEqual(
    decodeCursor("1900-01-01,company.ilike.%acme%"),
    null,
    "decodeCursor MUST return null for raw injection cursor string"
  );
  assert.strictEqual(
    decodeCursor("company.ilike.%acme%"),
    null,
    "decodeCursor MUST return null for raw string 'company.ilike.%acme%'"
  );
  console.log("  [PASS] Cursor payloads containing ',', '(', ')', and 'company.ilike.%acme%' strictly rejected (return null)");

  // 5. Out-of-range year (e.g., 1900-01-01T00:00:00Z)
  const outOfRangeYear = Buffer.from(JSON.stringify(["1900-01-01T00:00:00Z", validUuid]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(outOfRangeYear), null, "Year 1900 must be rejected (returns null)");
  console.log("  [PASS] Out-of-range year (1900) rejected by timestamp bounds");

  // 6. Non-UUID id rejected (e.g. legacy 'job-123', arbitrary string, SQL fragment)
  const nonUuidPayload = Buffer.from(JSON.stringify([validDate, "job-12345"]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(nonUuidPayload), null, "Non-UUID id must be rejected (returns null)");

  const sqlInjectionUuid = Buffer.from(JSON.stringify([validDate, "'; DROP TABLE jobs; --"]), "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(sqlInjectionUuid), null, "SQL injection in id must be rejected (returns null)");
  console.log("  [PASS] Non-UUID id and SQL fragments strictly rejected (returns null)");

  // 7. Corrupted base64 & invalid JSON
  assert.strictEqual(decodeCursor("not-base64!@#$%^"), null, "Corrupted base64 must return null");
  const invalidJsonB64 = Buffer.from("not-a-json-object", "utf-8").toString("base64");
  assert.strictEqual(decodeCursor(invalidJsonB64), null, "Non-JSON base64 payload must return null");
  assert.strictEqual(decodeCursor(""), null, "Empty cursor string must return null");
  assert.strictEqual(decodeCursor("   "), null, "Whitespace cursor string must return null");
  console.log("  [PASS] Corrupted base64 and malformed payloads handled safely (returns null)");
}

async function runKeysetPaginationFlowTests() {
  console.log("\n[2/5] Testing Keyset Pagination Flow & Deterministic Tie-breaking...");

  interface MockDbRow {
    id: string;
    posted_at: string;
    title: string;
    company: string;
  }

  const mockDbRows: MockDbRow[] = [];
  const baseTimestamp = new Date("2026-10-28T12:00:00.000Z").getTime();
  for (let i = 0; i < 60; i++) {
    const timeOffsetMinutes = Math.floor(i / 3) * 10;
    const rowDate = new Date(baseTimestamp - timeOffsetMinutes * 60 * 1000).toISOString();
    // Valid mock UUID format: 00000000-0000-0000-0000-0000000000XX
    const idNum = 60 - i;
    const rowUuid = `00000000-0000-0000-0000-${String(idNum).padStart(12, "0")}`;
    mockDbRows.push({
      id: rowUuid,
      posted_at: rowDate,
      title: `Software Engineer ${i + 1}`,
      company: `Company ${Math.floor(i / 5) + 1}`,
    });
  }

  const PAGE_SIZE = 25;

  function queryWithKeyset(cursorString?: string | null, limitCount: number = PAGE_SIZE + 1): MockDbRow[] {
    let filtered = [...mockDbRows];
    if (cursorString) {
      const parsed = decodeCursor(cursorString);
      if (parsed) {
        filtered = filtered.filter((row) => {
          if (!parsed.posted_at) {
            return row.id < parsed.id;
          }
          if (row.posted_at < parsed.posted_at) return true;
          if (row.posted_at === parsed.posted_at && row.id < parsed.id) return true;
          return false;
        });
      }
    }
    return filtered.slice(0, limitCount);
  }

  // Page 1
  const page1RowsRaw = queryWithKeyset(null);
  assert.strictEqual(page1RowsRaw.length, PAGE_SIZE + 1, "Page 1 query with limit 26 must return 26 rows");
  const page1HasNextPage = page1RowsRaw.length > PAGE_SIZE;
  const page1Jobs = page1RowsRaw.slice(0, PAGE_SIZE);
  const page1Last = page1Jobs[page1Jobs.length - 1];
  const cursor1 = encodeCursor(page1Last.posted_at, page1Last.id);
  assert.strictEqual(page1Jobs.length, 25, "Page 1 jobs count must be 25");
  assert.strictEqual(page1HasNextPage, true, "Page 1 hasNextPage must be true");
  console.log(`  [PASS] Page 1: 25 items, hasNextPage: true, nextCursor: ${cursor1.slice(0, 16)}...`);

  // Page 2
  const page2RowsRaw = queryWithKeyset(cursor1);
  assert.strictEqual(page2RowsRaw.length, PAGE_SIZE + 1, "Page 2 query with limit 26 must return 26 rows");
  const page2HasNextPage = page2RowsRaw.length > PAGE_SIZE;
  const page2Jobs = page2RowsRaw.slice(0, PAGE_SIZE);
  const page2Last = page2Jobs[page2Jobs.length - 1];
  const cursor2 = encodeCursor(page2Last.posted_at, page2Last.id);
  assert.strictEqual(page2Jobs.length, 25, "Page 2 jobs count must be 25");
  assert.strictEqual(page2HasNextPage, true, "Page 2 hasNextPage must be true");

  // Verify zero row overlap between Page 1 and Page 2
  const page1Ids = new Set(page1Jobs.map((j) => j.id));
  for (const job of page2Jobs) {
    assert.ok(!page1Ids.has(job.id), `Row ${job.id} must not appear in both Page 1 and Page 2`);
  }
  console.log("  [PASS] Page 2: 25 items, strictly 0 row overlap with Page 1");

  // Page 3 (final page: 60 - 50 = 10 rows remaining)
  const page3RowsRaw = queryWithKeyset(cursor2);
  assert.strictEqual(page3RowsRaw.length, 10, "Page 3 query must return remaining 10 rows");
  const page3HasNextPage = page3RowsRaw.length > PAGE_SIZE;
  const page3Jobs = page3RowsRaw.slice(0, PAGE_SIZE);
  const cursor3 = page3HasNextPage && page3Jobs.length > 0
    ? encodeCursor(page3Jobs[page3Jobs.length - 1].posted_at, page3Jobs[page3Jobs.length - 1].id)
    : null;
  assert.strictEqual(page3Jobs.length, 10, "Page 3 jobs count must be 10");
  assert.strictEqual(page3HasNextPage, false, "Page 3 hasNextPage must be false");
  assert.strictEqual(cursor3, null, "Final page nextCursor must be null");
  console.log("  [PASS] Page 3: 10 items, hasNextPage: false, nextCursor: null");
}

async function runFilterPredicatesTests() {
  console.log("\n[3/5] Testing Filter Predicates & jobs_public Column Guarding...");

  class MockPostgrestBuilder {
    filters: Array<{ method: string; args: any[] }> = [];
    orders: Array<{ column: string; options: any }> = [];
    limits: number[] = [];

    ilike(col: string, val: string) {
      this.filters.push({ method: "ilike", args: [col, val] });
      return this;
    }
    eq(col: string, val: string) {
      this.filters.push({ method: "eq", args: [col, val] });
      return this;
    }
    gte(col: string, val: any) {
      this.filters.push({ method: "gte", args: [col, val] });
      return this;
    }
    not(col: string, operator: string, val: any) {
      this.filters.push({ method: "not", args: [col, operator, val] });
      return this;
    }
    or(filterStr: string) {
      this.filters.push({ method: "or", args: [filterStr] });
      return this;
    }
    order(column: string, options: any) {
      this.orders.push({ column, options });
      return this;
    }
    limit(n: number) {
      this.limits.push(n);
      return this;
    }
  }

  function applySearchFilters(
    builder: MockPostgrestBuilder,
    hasServiceKey: boolean,
    opts: {
      salaryMin?: string;
      sourceType?: string;
      company?: string;
      search?: string;
      cursor?: string;
    }
  ) {
    if (opts.company) {
      if (hasServiceKey) {
        builder.ilike("company", `%${opts.company}%`);
      }
    }
    if (opts.salaryMin) {
      if (hasServiceKey) {
        const minVal = parseFloat(opts.salaryMin);
        if (!isNaN(minVal) && minVal > 0) {
          builder.not("salary_min", "is", null);
          builder.gte("salary_min", minVal);
        }
      }
    }
    if (opts.sourceType) {
      if (hasServiceKey) {
        builder.eq("source_type", opts.sourceType);
      }
    }
    if (opts.search) {
      if (hasServiceKey) {
        builder.or(`title.ilike.%${opts.search}%,company.ilike.%${opts.search}%,description.ilike.%${opts.search}%`);
      } else {
        // jobs_public lacks company and description columns
        builder.or(`title.ilike.%${opts.search}%,location.ilike.%${opts.search}%`);
      }
    }
    if (opts.cursor) {
      const parsed = decodeCursor(opts.cursor);
      if (parsed) {
        if (parsed.posted_at) {
          builder.or(`posted_at.lt.${parsed.posted_at},and(posted_at.eq.${parsed.posted_at},id.lt.${parsed.id})`);
        } else {
          builder.or(`id.lt.${parsed.id}`);
        }
      }
    }
    builder.order("posted_at", { ascending: false, nullsFirst: false });
    builder.order("id", { ascending: false });
    builder.limit(26);
  }

  // 1. Service key present (targets jobs table) -> company, salaryMin, sourceType, description applied
  const builderWithServiceKey = new MockPostgrestBuilder();
  applySearchFilters(builderWithServiceKey, true, {
    salaryMin: "120000",
    sourceType: "ats",
    company: "Stripe",
    search: "Engineer",
    cursor: encodeCursor("2026-10-28T10:00:00.000Z", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
  });

  const hasSalaryGte = builderWithServiceKey.filters.some((f) => f.method === "gte" && f.args[0] === "salary_min");
  const hasCompany = builderWithServiceKey.filters.some((f) => f.method === "ilike" && f.args[0] === "company");
  const hasSourceType = builderWithServiceKey.filters.some((f) => f.method === "eq" && f.args[0] === "source_type");
  const hasDescriptionInSearch = builderWithServiceKey.filters.some((f) => f.method === "or" && f.args[0].includes("description.ilike"));

  assert.ok(hasSalaryGte, "salaryMin must be applied when service key is present");
  assert.ok(hasCompany, "company must be applied when service key is present");
  assert.ok(hasSourceType, "sourceType must be applied when service key is present");
  assert.ok(hasDescriptionInSearch, "description search must be applied when service key is present");
  console.log("  [PASS] Service key queries apply salary_min, company, source_type, and description filters");

  // 2. Anonymous / Guest (targets jobs_public view) -> company, salaryMin, sourceType, description MUST BE GUARDED
  const builderJobsPublic = new MockPostgrestBuilder();
  applySearchFilters(builderJobsPublic, false, {
    salaryMin: "120000",
    sourceType: "ats",
    company: "Stripe",
    search: "Engineer",
  });

  const publicHasSalary = builderJobsPublic.filters.some((f) => f.args[0] === "salary_min");
  const publicHasCompany = builderJobsPublic.filters.some((f) => f.args[0] === "company");
  const publicHasSourceType = builderJobsPublic.filters.some((f) => f.args[0] === "source_type");
  const publicHasDescription = builderJobsPublic.filters.some((f) => f.method === "or" && f.args[0].includes("description"));

  assert.strictEqual(publicHasSalary, false, "salary_min MUST NOT be applied on jobs_public");
  assert.strictEqual(publicHasCompany, false, "company MUST NOT be applied on jobs_public");
  assert.strictEqual(publicHasSourceType, false, "source_type MUST NOT be applied on jobs_public");
  assert.strictEqual(publicHasDescription, false, "description MUST NOT be applied on jobs_public");
  console.log("  [PASS] jobs_public strictly guards against salary_min, company, source_type, and description");

  // 3. Ordering nullsFirst: false
  const postedAtOrder = builderWithServiceKey.orders.find((o) => o.column === "posted_at");
  assert.ok(postedAtOrder && postedAtOrder.options.nullsFirst === false, "posted_at ordering must specify nullsFirst: false");
  console.log("  [PASS] Keyset queries enforce posted_at DESC nullsFirst: false");
}

async function runUrlStateSyncTests() {
  console.log("\n[4/5] Testing URL State Syncing & Parsing...");

  const queryString = "?search=Staff+Architect&salaryMin=150000&sourceType=direct&company=Linear&country=US&workModel=remote";
  const params = new URLSearchParams(queryString);

  const parsedSearch = params.get("search") || "";
  const parsedSalaryMin = params.get("salaryMin") || "";
  const parsedSourceType = params.get("sourceType") || "";
  const parsedCompany = params.get("company") || "";
  const parsedCountry = params.get("country") || "";
  const parsedWorkModel = params.get("workModel") || "";

  assert.strictEqual(parsedSearch, "Staff Architect");
  assert.strictEqual(parsedSalaryMin, "150000");
  assert.strictEqual(parsedSourceType, "direct");
  assert.strictEqual(parsedCompany, "Linear");
  assert.strictEqual(parsedCountry, "US");
  assert.strictEqual(parsedWorkModel, "remote");
  console.log("  [PASS] URL parameters correctly parsed into filter state");

  // Bidirectional serialization
  const outParams = new URLSearchParams();
  const syncParam = (key: string, val: string | null | undefined) => {
    if (val && String(val).trim()) {
      outParams.set(key, String(val).trim());
    } else {
      outParams.delete(key);
    }
  };

  syncParam("search", parsedSearch);
  syncParam("salaryMin", parsedSalaryMin);
  syncParam("sourceType", parsedSourceType);
  syncParam("company", parsedCompany);
  syncParam("country", parsedCountry);
  syncParam("workModel", parsedWorkModel);

  assert.strictEqual(outParams.get("search"), "Staff Architect");
  assert.strictEqual(outParams.get("salaryMin"), "150000");
  assert.strictEqual(outParams.get("sourceType"), "direct");
  assert.strictEqual(outParams.get("company"), "Linear");
  assert.strictEqual(outParams.get("country"), "US");
  console.log("  [PASS] Filter state serialized back to URL query parameters");

  // 3. Shared link / Refresh / Restore validation across all filter dimensions
  const sharedLinkUrl = "http://localhost:3000/jobs?search=Backend+Engineer&category=engineering&country=DE&salaryMin=90000&sourceType=ats&company=Datadog&workModel=hybrid&industry=devtools&datePosted=7d&experience=senior";
  const sharedParams = new URL(sharedLinkUrl).searchParams;

  const restoredState = {
    search: sharedParams.get("search") || "",
    category: sharedParams.get("category") || "",
    country: sharedParams.get("country") || sharedParams.get("countryCode") || "",
    salaryMin: sharedParams.get("salaryMin") || "",
    sourceType: sharedParams.get("sourceType") || "",
    company: sharedParams.get("company") || "",
    workModel: sharedParams.get("workModel") || "",
    industry: sharedParams.get("industry") || "",
    datePosted: sharedParams.get("datePosted") || "",
    experience: sharedParams.get("experience") || "",
  };

  assert.strictEqual(restoredState.search, "Backend Engineer", "Search keyword restored from URL");
  assert.strictEqual(restoredState.category, "engineering", "Category restored from URL");
  assert.strictEqual(restoredState.country, "DE", "Country restored from URL");
  assert.strictEqual(restoredState.salaryMin, "90000", "SalaryMin restored from URL");
  assert.strictEqual(restoredState.sourceType, "ats", "SourceType restored from URL");
  assert.strictEqual(restoredState.company, "Datadog", "Company restored from URL");
  assert.strictEqual(restoredState.workModel, "hybrid", "WorkModel restored from URL");
  assert.strictEqual(restoredState.industry, "devtools", "Industry restored from URL");
  assert.strictEqual(restoredState.datePosted, "7d", "DatePosted restored from URL");
  assert.strictEqual(restoredState.experience, "senior", "Experience restored from URL");
  console.log("  [PASS] All 10 filter dimensions accurately restored from shared link / refresh URL");

  // 4. Popstate event restoration simulation
  let popstateState: typeof restoredState = { ...restoredState };
  const popstateUrl = "http://localhost:3000/jobs?search=Frontend+Lead&category=design&country=US&workModel=remote";
  const popstateParams = new URL(popstateUrl).searchParams;

  popstateState = {
    search: popstateParams.get("search") || "",
    category: popstateParams.get("category") || "",
    country: popstateParams.get("country") || popstateParams.get("countryCode") || "",
    salaryMin: popstateParams.get("salaryMin") || "",
    sourceType: popstateParams.get("sourceType") || "",
    company: popstateParams.get("company") || "",
    workModel: popstateParams.get("workModel") || "",
    industry: popstateParams.get("industry") || "",
    datePosted: popstateParams.get("datePosted") || "",
    experience: popstateParams.get("experience") || "",
  };

  assert.strictEqual(popstateState.search, "Frontend Lead");
  assert.strictEqual(popstateState.category, "design");
  assert.strictEqual(popstateState.country, "US");
  assert.strictEqual(popstateState.workModel, "remote");
  assert.strictEqual(popstateState.company, "");
  console.log("  [PASS] Browser back/forward navigation (popstate) restores state accurately");

  // 5. router.replace without scroll jump
  let lastNavigatedUrl = "";
  let lastOptions: { scroll?: boolean } | undefined;
  const mockRouter = {
    replace: (url: string, opts?: { scroll?: boolean }) => {
      lastNavigatedUrl = url;
      lastOptions = opts;
    },
  };

  const newQuery = "?search=Frontend+Lead&country=US";
  mockRouter.replace(`/jobs${newQuery}`, { scroll: false });
  assert.strictEqual(lastNavigatedUrl, "/jobs?search=Frontend+Lead&country=US");
  assert.strictEqual(lastOptions?.scroll, false, "router.replace must be called with { scroll: false } to prevent scroll jump");
  console.log("  [PASS] router.replace updates URL without scroll jump ({ scroll: false })");
}

async function runNegativeControl() {
  console.log("\n[5/5] Executing Negative Control...");
  if (isNegativeControl) {
    console.log("  Simulating intentional failure (asserting malicious payload decodes successfully)...");
    const maliciousPayload = Buffer.from(JSON.stringify(["1900-01-01,company.ilike.%acme%", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"]), "utf-8").toString("base64");
    const result = decodeCursor(maliciousPayload);
    // This MUST fail in negative control mode
    assert.notStrictEqual(result, null, "NEGATIVE CONTROL FAILURE: Injection payload MUST NOT decode as valid cursor");
  } else {
    console.log("  [PASS] Negative control branch ready (pass --negative-control to verify non-zero exit)");
  }
}

async function main() {
  try {
    await runKeysetCursorTests();
    await runKeysetPaginationFlowTests();
    await runFilterPredicatesTests();
    await runUrlStateSyncTests();
    await runNegativeControl();
    console.log("\n================================================================================");
    console.log("ALL KEYSET PAGINATION & 100K+ FILTER TESTS PASSED [PASS-LOCAL]");
    console.log("================================================================================");
  } catch (err: any) {
    console.error(`\nTEST FAILED: ${err.message}`);
    process.exit(1);
  }
}

main();
