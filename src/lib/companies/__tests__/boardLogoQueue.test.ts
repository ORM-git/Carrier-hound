import { afterEach, describe, expect, it, vi } from 'vitest';
import { enqueueBoardCompanyLogo } from '../logoQueue';
const ID='aaaaaaaa-0000-4000-8000-000000000001';
afterEach(()=>vi.unstubAllEnvs());
function client(found:any, insert:any={data:{id:ID,ats_type:'greenhouse'},error:null}) {
 const rpc=vi.fn(async(fn:string)=>({data:fn==='enqueue_company_logos'?1:{pending:1},error:null}));
 const insertFn=vi.fn(()=>({select:()=>({maybeSingle:async()=>insert})}));
 const eq=vi.fn(()=>({maybeSingle:async()=>found}));
 const from=vi.fn(()=>({select:()=>({eq}),insert:insertFn}));
 return {from,rpc,insertFn,eq};
}
describe('board ingestion shares the leased logo queue',()=>{
 it('queues existing stable company without uploading or resolving',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://proj.supabase.co');
  const sb=client({data:{id:ID,ats_type:'greenhouse'},error:null});
  expect(await enqueueBoardCompanyLogo(sb as any,{token:'acme',ats:'greenhouse-board'})).toMatchObject({status:'ok',enqueued:1});
  expect(sb.rpc).toHaveBeenCalledWith('enqueue_company_logos',{p_ids:[ID],p_origin:'https://proj.supabase.co'});
  expect(sb.insertFn).not.toHaveBeenCalled();
 });
 it('creates a named missing company without raw logo fields and queues it',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://proj.supabase.co');
  const sb=client({data:null,error:null});
  expect(await enqueueBoardCompanyLogo(sb as any,{token:'acme',ats:'greenhouse',company:'Acme'})).toMatchObject({status:'ok'});
  expect(sb.insertFn).toHaveBeenCalledWith({name:'Acme',slug:'acme',ats_type:'greenhouse',enabled:true});
 });
 it('does not invent a name, recreate a missing stable id, or cross an ATS binding',async()=>{
  for(const [found,target] of [
   [{data:null,error:null},{token:'acme',ats:'greenhouse'}],
   [{data:null,error:null},{id:ID,token:'acme',ats:'greenhouse',company:'Acme'}],
   [{data:{id:ID,ats_type:'lever'},error:null},{token:'acme',ats:'greenhouse'}]
  ] as const){ const sb=client(found);expect(await enqueueBoardCompanyLogo(sb as any,target)).toEqual({status:'skipped'});expect(sb.rpc).not.toHaveBeenCalled();expect(sb.insertFn).not.toHaveBeenCalled(); }
 });
 it('returns an error without throwing on lookup or enqueue failures',async()=>{
  const sb=client({data:null,error:{message:'lookup failed'}});
  expect(await enqueueBoardCompanyLogo(sb as any,{token:'acme',ats:'greenhouse'})).toEqual({status:'error',error:'lookup failed'});
 });
});
