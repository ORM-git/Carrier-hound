/**
 * Tests for scripts/diagnose-migration-replay.ts (diagnostic only; deliberately NOT registered in suite-runner.ts).
 * Offline: in-memory PGlite, no credentials, no network. Run: npx tsx scripts/test-diagnose-migration-replay.ts
 */
import { classify, replay, splitSql } from './diagnose-migration-replay';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`); }
}

async function main() {
  // Splitter: semicolons inside strings, quoted identifiers, dollar quotes and comments never split a statement.
  const sql = [
    "-- header; not a statement",
    "CREATE TABLE t (a text DEFAULT 'x;y', \"b;c\" int);",
    "/* block; comment */",
    "DO $$ BEGIN PERFORM 1; END $$;",
    "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $fn$ SELECT 'a;b' $fn$;",
    "INSERT INTO t VALUES ('it''s; fine', 1);",
  ].join('\n');
  const st = splitSql(sql);
  check('splitter: 4 statements', st.length === 4, st);
  check('splitter: statement start lines', JSON.stringify(st.map((s) => s.line)) === JSON.stringify([2, 4, 5, 6]), st.map((s) => s.line));
  check('splitter: keeps quoted semicolons intact', st[0].sql.includes("'x;y'") && st[0].sql.includes('"b;c"') && st[3].sql.includes("'it''s; fine'"));
  check('splitter: keeps dollar-quoted bodies intact', st[1].sql.endsWith('END $$') && st[2].sql.includes("$fn$ SELECT 'a;b' $fn$"));

  // E-strings: backslash escapes the quote and semicolons stay inside the literal.
  const e = splitSql("SELECT E'it\\'s; still \\\\ one;';\nSELECT e'\\';';\nSELECT 'plain\\';\nSELECT 2;");
  check('E-string: escaped quote and semicolon stay in one statement', e.length === 4 && e[0].sql === "SELECT E'it\\'s; still \\\\ one;'", e);
  check("E-string: lower-case e'...' is an escape string too", e[1].sql === "SELECT e'\\';'", e[1]);
  check("plain '...' keeps backslash literal (standard_conforming_strings=on)", e[2].sql === "SELECT 'plain\\'" && e[3].sql === 'SELECT 2', e.slice(2));
  const ident = splitSql("SELECT type'x;y'; SELECT 1;");
  check("a word ending in e before a quote is not an E-string prefix", ident.length === 2 && ident[0].sql === "SELECT type'x;y'", ident);

  // Nested block comments: semicolons anywhere inside are ignored; comment-only chunks are not statements.
  const n = splitSql('/* outer; /* inner; */ still comment; */\nSELECT 1;\n/* only a comment; */');
  check('nested block comment: one statement, on line 2', n.length === 1 && n[0].line === 2 && n[0].sql.endsWith('SELECT 1'), n);

  // Explicit rejections (thrown, never guessed).
  const throwsLike = (sql: string, re: RegExp) => { try { splitSql(sql); return false; } catch (err: any) { return re.test(err.message); } };
  check('rejects unterminated E-string', throwsLike("SELECT E'oops\\';", /unterminated E-string at line 1/));
  check('rejects unterminated string', throwsLike("SELECT 'oops;", /unterminated string/));
  check('rejects unterminated nested block comment', throwsLike('/* a /* b */ SELECT 1;', /unterminated block comment/));
  check('rejects unterminated dollar body', throwsLike('DO $x$ BEGIN END;', /unterminated dollar-quoted body \$x\$/));
  check('rejects psql meta-commands', throwsLike('SELECT 1;\n\\i other.sql\n', /psql meta-command at line 2/));

  // Classifier.
  check('classify: missing relation is an ordering/dependency gap', classify('42P01', 'relation "public.jobs_public" does not exist') === 'ordering-or-dependency-gap');
  check('classify: auth schema is a platform object', classify('3F000', 'schema "auth" does not exist') === 'supabase-platform-object');
  check('classify: unavailable extension', classify('0A000', 'extension "pg_cron" is not available') === 'unsupported-extension');
  check('classify: cron schema is an extension object', classify('3F000', 'schema "cron" does not exist') === 'unsupported-extension');
  check('classify: CONCURRENTLY in a transaction', classify('25001', 'DROP INDEX CONCURRENTLY cannot run inside a transaction block') === 'concurrent-index-in-transaction');

  // End to end: the documented order with the schema.sql baseline stops at the jobs_public grant, and never claims success.
  const r = await replay({ baseline: true, platformStubs: true });
  check('replay: stops (no silent skip of the failing statement)', r.status === 'STOPPED', r.status);
  check('replay: first error is 20261001_filter_upgrades.sql:211 relation public.jobs_public missing',
    r.firstError?.file === 'supabase/migrations/20261001_filter_upgrades.sql' && r.firstError.line === 211 && r.firstError.code === '42P01'
      && /jobs_public/.test(r.firstError.message) && r.firstError.category === 'ordering-or-dependency-gap', r.firstError);
  check('replay: no assumption was added unasked', r.assumptions.length === 0, r.assumptions);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
