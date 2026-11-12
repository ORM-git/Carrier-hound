/**
 * Offline test & AST static guard for client schema validation coverage under src/lib/api/.
 *
 * Run with: npx tsx scripts/test-client-schema-coverage.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import {
  ClientSchemaValidationError,
  parseSearchJobsFacetRows,
  parseSearchJobsRows,
  parseWorldwideCompanyRows,
} from "../src/lib/api/clientSchemas";
import { searchJobs } from "../src/lib/api/jobs";
import { getWorldwideCompanies } from "../src/lib/api/worldwide";
import { WORLDWIDE_COMPANIES } from "../src/data/companies";

function assertThrowsSchemaError(fn: () => unknown, expectedSchema: string, label: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof ClientSchemaValidationError,
    `${label}: expected ClientSchemaValidationError, got ${String(caught)}`
  );
  assert.equal(caught.name, "ClientSchemaValidationError", `${label}: error.name mismatch`);
  assert.equal(caught.schema, expectedSchema, `${label}: error.schema mismatch`);
  assert.ok(caught.reason.length > 0, `${label}: expected non-empty reason`);
}

function testSearchJobsRowValidator() {
  // Valid full + minimal rows
  const valid = parseSearchJobsRows([
    {
      id: "job-1",
      title: "Staff Engineer",
      company: "Acme",
      location: "Remote",
      date: "2026-11-12",
      first_seen_at: "2026-11-12T00:00:00Z",
      salary_text: "$180k - $220k",
      category: "software",
      remote: true,
      remote_scope: "remote",
      country_code: "US",
      country: "United States",
      job_type: "full-time",
      apply_url: "https://example.com/apply/1",
    },
    {
      id: "job-2",
      title: "Designer",
      company: "Beta",
      location: null,
      remote: null,
      apply_url: undefined,
    },
  ]);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].id, "job-1");
  assert.equal(valid[1].location, null);
  assert.deepEqual(parseSearchJobsRows([]), []);

  // Malformed payloads throw ClientSchemaValidationError at low level
  assertThrowsSchemaError(() => parseSearchJobsRows(null), "searchJobs.rows", "jobs null");
  assertThrowsSchemaError(() => parseSearchJobsRows({ rows: [] }), "searchJobs.rows", "jobs non-array object");
  assertThrowsSchemaError(() => parseSearchJobsRows(["not-an-object"]), "searchJobs.rows", "jobs string item");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ title: "Dev", company: "Acme" }]), "searchJobs.rows", "jobs missing id");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "   ", title: "Dev", company: "Acme" }]), "searchJobs.rows", "jobs blank id");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: 42, company: "Acme" }]), "searchJobs.rows", "jobs numeric title");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: null }]), "searchJobs.rows", "jobs null company");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", remote: "yes" }]), "searchJobs.rows", "jobs string remote");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", location: 123 }]), "searchJobs.rows", "jobs numeric location");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", apply_url: {} }]), "searchJobs.rows", "jobs object apply_url");
}

function testSearchJobsFacetValidator() {
  const valid = parseSearchJobsFacetRows([
    { category: "software", country: "United States" },
    { category: null, country: undefined },
    {},
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[0].category, "software");
  assert.equal(valid[1].category, null);
  assert.deepEqual(parseSearchJobsFacetRows([]), []);

  assertThrowsSchemaError(() => parseSearchJobsFacetRows("bad"), "searchJobs.facets", "facets string");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows({}), "searchJobs.facets", "facets object");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([null]), "searchJobs.facets", "facets null row");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([{ category: 101 }]), "searchJobs.facets", "facets numeric category");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([{ country: ["US"] }]), "searchJobs.facets", "facets array country");
}

function testWorldwideCompanyValidator() {
  const valid = parseWorldwideCompanyRows([
    { name: "Stripe", slug: "stripe", country: "United States", active_job_count: 85 },
    { name: "GitLab", slug: "gitlab", country: null, active_job_count: "42" },
    { name: "Linear", slug: "linear", active_job_count: 0 },
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[0].active_job_count, 85);
  assert.equal(valid[1].active_job_count, 42);
  assert.equal(valid[1].country, null);
  assert.deepEqual(parseWorldwideCompanyRows([]), []);

  assertThrowsSchemaError(() => parseWorldwideCompanyRows({}), "worldwideCompanyCounts.rows", "worldwide non-array");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([null]), "worldwideCompanyCounts.rows", "worldwide null row");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "", active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide empty slug");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: 123, slug: "stripe", active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide numeric name");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", country: 99, active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide numeric country");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: -1 }]), "worldwideCompanyCounts.rows", "worldwide negative count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: Number.NaN }]), "worldwideCompanyCounts.rows", "worldwide NaN count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: "not-a-num" }]), "worldwideCompanyCounts.rows", "worldwide non-numeric string count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: null }]), "worldwideCompanyCounts.rows", "worldwide null count");
}

async function testCallerSafeDegradation() {
  function mockJobsClient(mainPayload: { data: any; count: number; error: any }, facetPayload: { data: any }) {
    let callIndex = 0;
    const chain: any = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      ilike: () => chain,
      in: () => chain,
      gte: () => chain,
      order: () => chain,
      range: () => Promise.resolve(mainPayload),
      limit: () => {
        callIndex++;
        return Promise.resolve(facetPayload);
      },
      then: (resolve: (v: any) => void) => {
        callIndex++;
        return resolve(callIndex === 1 ? mainPayload : facetPayload);
      },
    };
    return chain;
  }

  // Silence logger console.warn during expected malformed-payload degradation checks
  const origWarn = console.warn;
  const warnedLines: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnedLines.push(args.map(String).join(" "));
  };

  try {
    // 1. searchJobs valid call
    const okClient = mockJobsClient(
      {
        data: [
          {
            id: "job-ok-1",
            title: "Backend Engineer",
            company: "Stripe",
            location: "Remote",
            category: "software",
            remote: true,
            country: "United States",
            apply_url: "https://stripe.com/jobs/1",
          },
        ],
        count: 1,
        error: null,
      },
      { data: [{ category: "software", country: "United States" }] }
    );
    const okRes = await searchJobs({}, okClient);
    assert.equal(okRes.jobs.length, 1);
    assert.equal(okRes.jobs[0].id, "job-ok-1");
    assert.equal(okRes.facets.categories.software, 1);

    // 2. searchJobs malformed primary rows -> logs safely and degrades to empty jobs without throwing
    const badJobsRes = await searchJobs(
      {},
      mockJobsClient(
        { data: [{ id: "job-bad", title: 123, company: "Stripe" }], count: 1, error: null },
        { data: [{ category: "software", country: "United States" }] }
      )
    );
    assert.deepEqual(badJobsRes.jobs, [], "Malformed job rows should degrade to empty jobs list");
    assert.equal(badJobsRes.facets.categories.software, 1, "Valid facets still preserved on primary row degrade");

    // 3. searchJobs malformed facet rows -> preserves valid jobs and degrades facets to empty + static country fallback
    const badFacetsRes = await searchJobs(
      {},
      mockJobsClient(
        {
          data: [{ id: "job-ok-2", title: "Designer", company: "Linear" }],
          count: 1,
          error: null,
        },
        { data: [{ category: 404, country: "US" }] }
      )
    );
    assert.equal(badFacetsRes.jobs.length, 1, "Valid job rows must still be returned if facets are malformed");
    assert.deepEqual(badFacetsRes.facets, { categories: {}, countries: {} });
    assert.ok(
      badFacetsRes.availableCountries.includes("United States"),
      "Malformed facet rows should fall back to static availableCountries list"
    );

    // 4. Worldwide valid + missing-view fallback
    const okWorldwideClient = {
      from: () => ({
        select: () =>
          Promise.resolve({
            data: [{ name: "Stripe", slug: "stripe", country: "United States", active_job_count: 17 }],
            error: null,
          }),
      }),
    };
    const wwOk = await getWorldwideCompanies(okWorldwideClient);
    assert.equal(wwOk.find((c) => c.slug === "stripe")?.jobCount, 17);

    const errWorldwideClient = {
      from: () => ({
        select: () => Promise.resolve({ data: null, error: { code: "42P01", message: "missing" } }),
      }),
    };
    const wwFallback = await getWorldwideCompanies(errWorldwideClient);
    assert.equal(wwFallback.length, WORLDWIDE_COMPANIES.length);

    // 5. Worldwide caller-level safe degrade: one malformed active_job_count row MUST NOT throw;
    //    WorldwidePage caller gets the static catalog fallback cleanly.
    const oneMalformedRowClient = {
      from: () => ({
        select: () =>
          Promise.resolve({
            data: [
              { name: "Stripe", slug: "stripe", country: "United States", active_job_count: 85 },
              { name: "GitLab", slug: "gitlab", country: "United States", active_job_count: "bad" },
            ],
            error: null,
          }),
      }),
    };
    const wwDegraded = await getWorldwideCompanies(oneMalformedRowClient);
    assert.equal(
      JSON.stringify(wwDegraded),
      JSON.stringify(WORLDWIDE_COMPANIES),
      "One malformed worldwide row must degrade safely to static WORLDWIDE_COMPANIES fallback"
    );

    // Non-array malformed worldwide payload also degrades safely
    const nonArrayWorldwideClient = {
      from: () => ({
        select: () => Promise.resolve({ data: { corrupt: true }, error: null }),
      }),
    };
    const wwNonArrayDegraded = await getWorldwideCompanies(nonArrayWorldwideClient);
    assert.equal(
      JSON.stringify(wwNonArrayDegraded),
      JSON.stringify(WORLDWIDE_COMPANIES),
      "Non-array worldwide payload must degrade safely to static WORLDWIDE_COMPANIES fallback"
    );

    assert.ok(
      warnedLines.some((line) => line.includes("CLIENT_SCHEMA_VALIDATION_FAILED")),
      "Safe degrade boundaries should emit structured CLIENT_SCHEMA_VALIDATION_FAILED warnings"
    );
  } finally {
    console.warn = origWarn;
  }
}

const EXEMPT_OR_SERVER_MODULES = new Set([
  "clientSchemas.ts", // validator module itself
  "retryFetch.ts", // generic transport wrapper, does not parse JSON or hold a schema
  "sharedRateLimit.ts", // server-only rate limiter using SUPABASE_SERVICE_ROLE_KEY
  "stats.ts", // explicitly exempted by task scope (already calls parseStatsResponse; PR #546)
]);

const NON_QUERY_RECEIVERS = new Set(["Array", "Buffer", "Object", "Set", "Map"]);

function collectExportedValidatorNames(clientSchemasSource: string): Set<string> {
  const sf = ts.createSourceFile("clientSchemas.ts", clientSchemasSource, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      /^parse[A-Z]/.test(stmt.name.text)
    ) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

function collectImportedClientSchemaValidators(
  sf: ts.SourceFile,
  knownValidators: Set<string>
): Set<string> {
  const imported = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    if (mod !== "./clientSchemas" && mod !== "@/lib/api/clientSchemas") continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      const exportedName = (el.propertyName ?? el.name).text;
      if (knownValidators.has(exportedName)) {
        imported.add(el.name.text);
      }
    }
  }
  return imported;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function isFetchOrQueryCall(call: ts.CallExpression): boolean {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text === "fetch" || call.expression.text === "fetchWithRetry";
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    const method = call.expression.name.text;
    if (method !== "from" && method !== "rpc") return false;
    const recv = call.expression.expression;
    if (ts.isIdentifier(recv) && NON_QUERY_RECEIVERS.has(recv.text)) return false;
    return true;
  }
  return false;
}

function extractBoundResponseNames(nameNode: ts.BindingName | ts.Expression): Set<string> {
  const names = new Set<string>();
  if (ts.isIdentifier(nameNode)) {
    names.add(nameNode.text);
    return names;
  }
  if (ts.isObjectBindingPattern(nameNode)) {
    const dataProp = nameNode.elements.find((el) => {
      if (el.propertyName && ts.isIdentifier(el.propertyName)) {
        return el.propertyName.text === "data";
      }
      return !el.propertyName && ts.isIdentifier(el.name) && el.name.text === "data";
    });
    if (dataProp) {
      for (const n of extractBoundResponseNames(dataProp.name)) names.add(n);
      return names;
    }
    for (const el of nameNode.elements) {
      const propName =
        el.propertyName && ts.isIdentifier(el.propertyName)
          ? el.propertyName.text
          : ts.isIdentifier(el.name)
            ? el.name.text
            : "";
      if (propName === "error" || propName === "count" || propName === "status") continue;
      for (const n of extractBoundResponseNames(el.name)) names.add(n);
    }
  } else if (ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el)) {
        for (const n of extractBoundResponseNames(el.name)) names.add(n);
      }
    }
  }
  return names;
}

function subtreeReferencesAnyIdentifier(node: ts.Node, targets: Set<string>): boolean {
  let found = false;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isIdentifier(n) && targets.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function climbFluentChain(expr: ts.Expression): ts.Expression {
  let curr: ts.Node = expr;
  while (curr.parent) {
    if (ts.isPropertyAccessExpression(curr.parent) && curr.parent.expression === curr) {
      curr = curr.parent;
    } else if (ts.isCallExpression(curr.parent) && curr.parent.expression === curr) {
      curr = curr.parent;
    } else {
      break;
    }
  }
  return curr as ts.Expression;
}

function collectScopeNodesWithoutNestedFunctions(
  root: ts.Node,
  outCalls: ts.CallExpression[],
  outVarDecls: ts.VariableDeclaration[],
  outBinAssigns: ts.BinaryExpression[]
) {
  function walk(node: ts.Node) {
    if (node !== root && isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) outCalls.push(node);
    if (ts.isVariableDeclaration(node)) outVarDecls.push(node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      outBinAssigns.push(node);
    }
    ts.forEachChild(node, walk);
  }
  walk(root);
}

/**
 * Intraprocedural AST binding heuristic:
 * Traces each fetch/query call inside its enclosing function to ensure its
 * returned response binding flows into an imported `clientSchemas.ts` validator
 * call executed strictly after that fetch's await/call site.
 */
export function auditApiModuleSource(
  fileName: string,
  source: string,
  knownValidators: Set<string>
): string | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  if (fileName === "retryFetch.ts") {
    const calls: ts.CallExpression[] = [];
    function findCalls(n: ts.Node) {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, findCalls);
    }
    findCalls(sf);
    const bad = calls.find(
      (c) =>
        ts.isPropertyAccessExpression(c.expression) &&
        (c.expression.name.text === "json" ||
          c.expression.name.text === "from" ||
          c.expression.name.text === "rpc")
    );
    if (bad) {
      return `${fileName}: transport wrapper unexpectedly parses JSON or queries Supabase`;
    }
    return null;
  }

  if (fileName === "sharedRateLimit.ts") {
    const calls: ts.CallExpression[] = [];
    function findCalls(n: ts.Node) {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, findCalls);
    }
    findCalls(sf);
    if (calls.some((c) => ts.isIdentifier(c.expression) && c.expression.text === "fetch")) {
      return `${fileName}: server-side rate limiter unexpectedly calls fetch()`;
    }
    return null;
  }

  if (fileName === "stats.ts") {
    const imported = collectImportedClientSchemaValidators(sf, knownValidators);
    if (!imported.has("parseStatsResponse")) {
      return `${fileName}: expected parseStatsResponse import from ./clientSchemas`;
    }
    return null;
  }

  if (EXEMPT_OR_SERVER_MODULES.has(fileName)) {
    return null;
  }

  const importedValidators = collectImportedClientSchemaValidators(sf, knownValidators);

  const functions: FunctionLike[] = [];
  function collectFunctions(n: ts.Node) {
    if (isFunctionLike(n)) functions.push(n);
    ts.forEachChild(n, collectFunctions);
  }
  collectFunctions(sf);

  for (const fn of functions) {
    if (!fn.body) continue;
    const calls: ts.CallExpression[] = [];
    const varDecls: ts.VariableDeclaration[] = [];
    const binAssigns: ts.BinaryExpression[] = [];
    collectScopeNodesWithoutNestedFunctions(fn.body, calls, varDecls, binAssigns);

    const fetchCalls = calls.filter(isFetchOrQueryCall);
    if (fetchCalls.length === 0) continue;

    if (importedValidators.size === 0) {
      return `${fileName}: contains ${fetchCalls.length} fetch/query call(s) without importing a validator from ./clientSchemas`;
    }

    const validatorCalls = calls.filter(
      (c) => ts.isIdentifier(c.expression) && importedValidators.has(c.expression.text)
    );
    const consumedValidatorCalls = new Set<ts.CallExpression>();

    for (const fetchCall of fetchCalls) {
      const line = sf.getLineAndCharacterOfPosition(fetchCall.getStart(sf)).line + 1;
      const chainRoot = climbFluentChain(fetchCall);

      // Check inline validation: validatorCall(...await fetchCall...)
      let inlineMatched = false;
      for (const vCall of validatorCalls) {
        if (consumedValidatorCalls.has(vCall)) continue;
        if (
          vCall.arguments.some(
            (arg) =>
              fetchCall.getStart(sf) >= arg.getStart(sf) &&
              fetchCall.getEnd() <= arg.getEnd()
          )
        ) {
          consumedValidatorCalls.add(vCall);
          inlineMatched = true;
          break;
        }
      }
      if (inlineMatched) continue;

      // Track chain variable or direct awaited assignment
      let execPos: number | null = null;
      const responseVars = new Set<string>();

      if (ts.isAwaitExpression(chainRoot.parent)) {
        const awaitNode = chainRoot.parent;
        execPos = awaitNode.getEnd();
        if (ts.isVariableDeclaration(awaitNode.parent) && awaitNode.parent.initializer === awaitNode) {
          for (const n of extractBoundResponseNames(awaitNode.parent.name)) {
            responseVars.add(n);
          }
        } else if (
          ts.isBinaryExpression(awaitNode.parent) &&
          awaitNode.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          awaitNode.parent.right === awaitNode
        ) {
          for (const n of extractBoundResponseNames(awaitNode.parent.left)) {
            responseVars.add(n);
          }
        }
      } else if (
        ts.isVariableDeclaration(chainRoot.parent) &&
        chainRoot.parent.initializer === chainRoot &&
        ts.isIdentifier(chainRoot.parent.name)
      ) {
        // Multi-step query builder variable: let query = supabase.from(...) ... await query
        const builderVars = new Set<string>([chainRoot.parent.name.text]);
        for (const decl of varDecls) {
          if (decl.getStart(sf) <= chainRoot.getEnd()) continue;
          if (!decl.initializer) continue;
          if (ts.isAwaitExpression(decl.initializer)) {
            if (subtreeReferencesAnyIdentifier(decl.initializer.expression, builderVars)) {
              execPos = decl.initializer.getEnd();
              for (const n of extractBoundResponseNames(decl.name)) {
                responseVars.add(n);
              }
              break;
            }
          } else if (ts.isIdentifier(decl.name) && subtreeReferencesAnyIdentifier(decl.initializer, builderVars)) {
            builderVars.add(decl.name.text);
          }
        }
        if (execPos === null) {
          for (const bin of binAssigns) {
            if (bin.getStart(sf) <= chainRoot.getEnd()) continue;
            if (ts.isAwaitExpression(bin.right) && subtreeReferencesAnyIdentifier(bin.right.expression, builderVars)) {
              execPos = bin.right.getEnd();
              for (const n of extractBoundResponseNames(bin.left)) {
                responseVars.add(n);
              }
              break;
            }
          }
        }
      }

      if (execPos === null || responseVars.size === 0) {
        return `${fileName}:${line}: fetch/query response is not bound to an awaited response variable passed into a clientSchemas validator`;
      }

      // Propagate single-function local variable derivations after execPos (e.g. const json = await res.json())
      for (const decl of varDecls) {
        if (decl.getStart(sf) <= execPos) continue;
        if (!decl.initializer) continue;
        if (subtreeReferencesAnyIdentifier(decl.initializer, responseVars)) {
          for (const n of extractBoundResponseNames(decl.name)) {
            responseVars.add(n);
          }
        }
      }

      const matchingValidator = validatorCalls.find(
        (vCall) =>
          !consumedValidatorCalls.has(vCall) &&
          vCall.getStart(sf) > execPos! &&
          vCall.arguments.some((arg) => subtreeReferencesAnyIdentifier(arg, responseVars))
      );

      if (!matchingValidator) {
        return `${fileName}:${line}: awaited fetch/query binding (${Array.from(responseVars).join(", ")}) is not validated by an imported clientSchemas validator afterwards`;
      }

      consumedValidatorCalls.add(matchingValidator);
    }
  }

  return null;
}

function testStaticCoverage() {
  const repoRoot = path.resolve(__dirname, "..");
  const apiDir = path.join(repoRoot, "src", "lib", "api");
  const docPath = path.join(repoRoot, "docs", "client-schema-validation.md");

  assert.ok(fs.existsSync(docPath), "docs/client-schema-validation.md must exist");
  const docText = fs.readFileSync(docPath, "utf8");
  const clientSchemasSource = fs.readFileSync(path.join(apiDir, "clientSchemas.ts"), "utf8");
  const knownValidators = collectExportedValidatorNames(clientSchemasSource);
  assert.ok(
    knownValidators.has("parseSearchJobsRows") &&
      knownValidators.has("parseSearchJobsFacetRows") &&
      knownValidators.has("parseWorldwideCompanyRows"),
    "clientSchemas.ts must export expected runtime validators"
  );

  const entries = fs.readdirSync(apiDir, { withFileTypes: true });
  const tsFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => e.name)
    .sort();

  assert.ok(tsFiles.length >= 10, `Expected src/lib/api/*.ts files, found ${tsFiles.length}`);

  const failures: string[] = [];
  for (const fileName of tsFiles) {
    assert.ok(
      docText.includes(`src/lib/api/${fileName}`),
      `docs/client-schema-validation.md must document src/lib/api/${fileName}`
    );
    const source = fs.readFileSync(path.join(apiDir, fileName), "utf8");
    const err = auditApiModuleSource(fileName, source, knownValidators);
    if (err) failures.push(err);
  }
  assert.deepEqual(failures, [], `Static coverage check failed:\n${failures.join("\n")}`);

  // Negative test 1: unused clientSchemas import + unrelated parseInt call must fail
  const negUnusedImportWithParseInt = auditApiModuleSource(
    "negUnusedImport.ts",
    `import { parseSearchJobsRows } from "./clientSchemas";
     export async function load() {
       const res = await fetch("/api/example");
       const n = parseInt("42", 10);
       return { json: await res.json(), n };
     }`,
    knownValidators
  );
  assert.ok(
    negUnusedImportWithParseInt !== null,
    "Static guard must fail on unvalidated fetch with unused clientSchemas import and unrelated parseInt"
  );

  // Negative test 2: unrelated parseSearchJobsRows([]) not applied to the later query result must fail
  const negUnrelatedValidatorCall = auditApiModuleSource(
    "negUnrelatedValidator.ts",
    `import { parseSearchJobsRows } from "./clientSchemas";
     export async function load(sb: any) {
       parseSearchJobsRows([]);
       const { data } = await sb.from("jobs_public").select("*");
       return data;
     }`,
    knownValidators
  );
  assert.ok(
    negUnrelatedValidatorCall !== null,
    "Static guard must fail when parseSearchJobsRows([]) is unrelated to the later query result"
  );

  // Negative test 3: unvalidated second path in the same file must fail
  const negSecondPath = auditApiModuleSource(
    "negSecondPath.ts",
    `import { parseSearchJobsRows } from "./clientSchemas";
     export async function load(sb: any) {
       const a = await sb.from("a").select("*");
       parseSearchJobsRows(a.data);
       const b = await sb.from("b").select("*");
       return b.data;
     }`,
    knownValidators
  );
  assert.ok(
    negSecondPath !== null,
    "Static guard must fail when a second query path in the same file lacks validation"
  );
}

async function main() {
  testSearchJobsRowValidator();
  testSearchJobsFacetValidator();
  testWorldwideCompanyValidator();
  await testCallerSafeDegradation();
  testStaticCoverage();
  console.log(
    "[PASS] test-client-schema-coverage: all fixture, caller safe-degradation, and AST static checks passed."
  );
}

main().catch((err) => {
  console.error("[FAIL] test-client-schema-coverage:", err);
  process.exit(1);
});
