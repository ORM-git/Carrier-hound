import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
const SQL=fs.readFileSync('docs/proposed/executable/20261126c_advanced_skill_filter_rpc.sql','utf8');
const CASES: Array<{input:string;key:string}>=JSON.parse(fs.readFileSync('src/lib/jobs/__tests__/fixtures/skill-key-cases.json','utf8'));
let pg:PGlite;
beforeAll(async()=>{
  pg=new PGlite();
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.jobs(id int, title text, skills text[], top_keywords text[],status text,is_active boolean,source_type text);
    INSERT INTO jobs VALUES(1,'React role',ARRAY[' React '],ARRAY['go'],'active',true,null),
      (2,'Other',ARRAY['React Native'],ARRAY['react'],'active',true,null),
      (3,'Unknown',null,null,'active',true,null),
      (4,'Inactive',ARRAY['SQL'],null,'active',false,null),
      (5,'Hidden source',ARRAY['SQL'],null,'active',true,'jobspy');`);
  await pg.exec(SQL);
});
afterAll(async()=>{await pg?.close();});
async function code(sql:string){try{await pg.exec(sql);return null;}catch(e:any){return e.code;}}
describe('excluded skill RPC review-only fixture',()=>{
  it('canonical SQL normalizer matches every backend-owned shared fixture',async()=>{
    for(const c of CASES) expect((await pg.query<{k:string}>('SELECT public.advanced_skill_key($1) k',[c.input])).rows[0].k,c.input).toBe(c.key);
  });
  it('exact skills ONLY, unknown retained, hard source/active gates and outer predicates/order/limit compose',async()=>{
    expect((await pg.query('SELECT id FROM public.jobs_without_excluded_skills($1) ORDER BY id',[['react']])).rows).toEqual([{id:2},{id:3}]);
    expect((await pg.query("SELECT id FROM public.jobs_without_excluded_skills(ARRAY['react']) WHERE title='Other' ORDER BY id DESC LIMIT 1")).rows).toEqual([{id:2}]);
    expect((await pg.query('SELECT id FROM public.jobs_without_excluded_skills(NULL) ORDER BY id')).rows).toEqual([{id:1},{id:2},{id:3}]);
    expect((await pg.query("SELECT id FROM public.jobs_without_excluded_skills('{}') ORDER BY id")).rows).toEqual([{id:1},{id:2},{id:3}]);
  });
  it('rejects malformed/oversize lists and no substring wildcard behavior',async()=>{
    for(const bad of ["ARRAY[NULL]::text[]","ARRAY['   ']","ARRAY[array['x']]","array_fill('x'::text,ARRAY[51])","ARRAY[repeat('x',101)]","'[0:0]={x}'::text[]"])
      expect(await code(`SELECT * FROM public.jobs_without_excluded_skills(${bad})`),bad).toBe('22023');
    expect((await pg.query("SELECT id FROM public.jobs_without_excluded_skills(ARRAY['%']) ORDER BY id")).rows).toEqual([{id:1},{id:2},{id:3}]);
  });
  it('validates independently of row presence and does not truncate stored values',async()=>{
    await pg.exec('BEGIN; DELETE FROM jobs; SAVEPOINT validation;');
    expect(await code("SELECT * FROM public.jobs_without_excluded_skills(ARRAY[repeat('x',101)])")).toBe('22023');
    await pg.exec('ROLLBACK TO SAVEPOINT validation;');
    await pg.exec("INSERT INTO jobs VALUES(10,'Long',ARRAY[repeat('x',101)],null,'active',true,null);");
    expect((await pg.query("SELECT id FROM public.jobs_without_excluded_skills(ARRAY[repeat('x',100)])")).rows).toEqual([{id:10}]);
    await pg.exec('ROLLBACK;');
  });
  it('only service role execute, no definer escalation; rerun preserves contract',async()=>{
    for(const name of ['advanced_skill_key(text)','jobs_without_excluded_skills(text[])']){
      for(const role of ['anon','authenticated']) expect((await pg.query<{ok:boolean}>('SELECT has_function_privilege($1,$2,$3) ok',[role,'public.'+name,'EXECUTE'])).rows[0].ok).toBe(false);
      expect((await pg.query<{ok:boolean}>('SELECT has_function_privilege($1,$2,$3) ok',['service_role','public.'+name,'EXECUTE'])).rows[0].ok).toBe(true);
    }
    expect((await pg.query<{prosecdef:boolean}>("SELECT prosecdef FROM pg_proc WHERE oid='public.jobs_without_excluded_skills(text[])'::regprocedure")).rows[0].prosecdef).toBe(false);
    await pg.exec(SQL);
    await pg.exec('SET ROLE anon');
    expect(await code("SELECT * FROM public.jobs_without_excluded_skills('{}')")).toBe('42501');
    await pg.exec('RESET ROLE; GRANT SELECT ON jobs TO service_role; SET ROLE service_role;');
    expect((await pg.query("SELECT count(*)::int n FROM public.jobs_without_excluded_skills(ARRAY['react'])")).rows).toEqual([{n:2}]);
    await pg.exec('RESET ROLE;');
  });
});
