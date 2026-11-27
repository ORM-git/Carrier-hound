import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const SQL = fs.readFileSync('docs/proposed/executable/20261126b_advanced_preferences_slice1.sql', 'utf8');
let pg: PGlite;
beforeAll(async () => { pg = new PGlite(); await pg.waitReady; });
afterAll(async () => { await pg?.close(); });
async function reset(jobType = 'integer', extra = '') {
  await pg.exec('ROLLBACK; DROP TABLE IF EXISTS public.jobs,public.user_preferences CASCADE;');
  await pg.exec(`CREATE TABLE public.jobs(id int, min_experience_years ${jobType}, max_experience_years ${jobType});
    CREATE TABLE public.user_preferences(user_id text, experience_level text${extra});`);
}
async function apply() {
  try { await pg.exec(SQL); return null; }
  catch (e: any) { await pg.exec('ROLLBACK'); return { code: e.code, message: e.message }; }
}
const type = async (tbl: string, col: string) => (await pg.query<{t:string}>(
  `SELECT format_type(atttypid,atttypmod) t FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped`, [`public.${tbl}`,col])).rows[0]?.t;
const rejects = async (sql: string) => { try { await pg.exec(sql); return null; } catch(e:any) { return e.code; } };

describe('advanced preferences migration, fixture only, NOT APPLIED live', () => {
  it('fresh integer schema widens losslessly, adds nullable fields, preserves legacy level, reruns', async () => {
    await reset(); await pg.exec(`INSERT INTO jobs VALUES(1,2147483647,NULL); INSERT INTO user_preferences VALUES('u','entry');`);
    expect(await apply()).toBeNull(); expect(await apply()).toBeNull();
    expect(await type('jobs','min_experience_years')).toBe('numeric');
    expect((await pg.query('SELECT min_experience_years::text AS n FROM jobs')).rows[0]).toEqual({n:'2147483647'});
    expect((await pg.query('SELECT experience_level,required_years_min,preferred_skills FROM user_preferences')).rows[0]).toEqual({experience_level:'entry',required_years_min:null,preferred_skills:null});
  });
  it('unconstrained numeric and decimal data survive unchanged', async () => {
    await reset('numeric'); await pg.exec('INSERT INTO jobs VALUES(1,0.125,999999.123456)');
    expect(await apply()).toBeNull();
    expect((await pg.query('SELECT min_experience_years::text a,max_experience_years::text b FROM jobs')).rows[0]).toEqual({a:'0.125',b:'999999.123456'});
  });
  it('missing required job column fails closed without partial preference columns', async () => {
    await reset(); await pg.exec('ALTER TABLE jobs DROP COLUMN max_experience_years');
    expect((await apply())?.code).toBe('42703'); expect(await type('user_preferences','preferred_skills')).toBeUndefined();
  });
  it('wrong existing type fails closed rather than silently skipping', async () => {
    await reset('double precision'); expect((await apply())?.code).toBe('42804');
    await reset('integer',', preferred_skills text'); expect((await apply())?.code).toBe('42804');
  });
  it('invalid existing rows roll back widening and all added columns', async () => {
    await reset(); await pg.exec('INSERT INTO jobs VALUES(1,NULL,-1)');
    expect((await apply())?.code).toBe('23514');
    expect(await type('jobs','min_experience_years')).toBe('integer'); expect(await type('user_preferences','preferred_skills')).toBeUndefined();
  });
  it('negative, inverted and nonfinite job/preference bounds reject, including max-only negative', async () => {
    await reset('numeric'); expect(await apply()).toBeNull();
    for (const [min,max] of [[null,'-1'],['-1',null],['4','2'],['NaN',null],[null,'Infinity'],['-Infinity',null]]) {
      const lit = (v: string|null) => v===null?'NULL':`'${v}'::numeric`;
      expect(await rejects(`INSERT INTO jobs VALUES(1,${lit(min)},${lit(max)},NULL)`)).toBe('23514');
      expect(await rejects(`INSERT INTO user_preferences(user_id,required_years_min,required_years_max) VALUES('u',${lit(min)},${lit(max)})`)).toBe('23514');
    }
    expect(await rejects(`INSERT INTO user_preferences(user_id,required_years_min,required_years_max) VALUES('u',11,NULL)`)).toBeNull();
  });
  it('50 skill cap, nullable/unbounded values and independent lists', async () => {
    await reset(); expect(await apply()).toBeNull();
    await pg.exec(`INSERT INTO user_preferences(user_id,preferred_skills,excluded_skills) VALUES('u',array_fill('x'::text,ARRAY[50]),ARRAY[]::text[])`);
    expect(await rejects(`UPDATE user_preferences SET excluded_skills=array_fill('x'::text,ARRAY[51])`)).toBe('23514');
  });
  it('dependent view blocks widening atomically; never drops or replaces the view', async () => {
    await reset(); await pg.exec('CREATE VIEW public.advanced_years_probe AS SELECT min_experience_years FROM public.jobs');
    expect((await apply())?.code).toBe('0A000');
    expect(await type('jobs','min_experience_years')).toBe('integer');
    expect(await type('user_preferences','preferred_skills')).toBeUndefined();
    expect((await pg.query<{n:string}>(`SELECT to_regclass('public.advanced_years_probe')::text n`)).rows[0].n).toBe('advanced_years_probe');
  });
  it('partially migrated nullable preference fields preserve decimals and validate existing invalid rows', async () => {
    await reset('integer',', required_years_min numeric');
    await pg.exec(`INSERT INTO user_preferences(user_id,required_years_min) VALUES('u',2.5)`);
    expect(await apply()).toBeNull();
    expect((await pg.query('SELECT required_years_min::text n,required_years_max FROM user_preferences')).rows[0]).toEqual({n:'2.5',required_years_max:null});
    await reset('integer',', required_years_max numeric');
    await pg.exec(`INSERT INTO user_preferences(user_id,required_years_max) VALUES('u',-1)`);
    expect((await apply())?.code).toBe('23514');
    expect(await type('jobs','min_experience_years')).toBe('integer');
    await reset('integer',', excluded_skills text[]');
    await pg.exec(`INSERT INTO user_preferences(user_id,excluded_skills) VALUES('u',array_fill('x'::text,ARRAY[51]))`);
    expect((await apply())?.code).toBe('23514');
    await reset('numeric(4,1)'); expect((await apply())?.code).toBe('42804');
  });
  it('same-name weaker check rejects; correct NOT VALID check validates existing rows', async () => {
    await reset('numeric'); await pg.exec('ALTER TABLE jobs ADD CONSTRAINT jobs_required_experience_bounds_check CHECK(true)');
    expect((await apply())?.code).toBe('42710');
    await reset(); expect(await apply()).toBeNull();
    const def=(await pg.query<{d:string}>(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='jobs'::regclass AND conname='jobs_required_experience_bounds_check'`)).rows[0].d;
    await pg.exec(`ALTER TABLE jobs DROP CONSTRAINT jobs_required_experience_bounds_check; ALTER TABLE jobs ADD CONSTRAINT jobs_required_experience_bounds_check ${def} NOT VALID`);
    expect(await apply()).toBeNull();
    expect((await pg.query<{convalidated:boolean}>(`SELECT convalidated FROM pg_constraint WHERE conrelid='jobs'::regclass AND conname='jobs_required_experience_bounds_check'`)).rows[0].convalidated).toBe(true);
  });
});
