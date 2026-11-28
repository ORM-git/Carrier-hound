import {it,expect,vi} from 'vitest';
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:(table:string)=>{let count=false;const b:any=new Proxy({},{get:(_,key)=>{
if(key==='then')return (resolve:any)=>resolve({data:count?null:rows,count:rows.length,error:null});
if(key==='maybeSingle')return async()=>({data:null,error:null});
if(key==='select')return (_:any,o:any)=>{count=!!o?.head;return b};
return ()=>b;
}});return b}})}));
const rows=[...['Bangalore','Remote worldwide'].flatMap((location,n)=>['Verified Employer',' Real Co ','',null,5].map((company,i)=>({id:`${n}-${i}`,company,location,country_code:'IN',remote_scope:n?'remote':null,remote_eligibility:n?'worldwide':null,verified:true})))];
it('actualAPI excludesmasked/blank/nonstrings fromcity+worldwide, preservingcounts',async()=>{
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://fixture.invalid');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','fixture-only');
const {GET}=await import('../route');const r=await GET(new Request('https://fixture.invalid/api/radar'));expect(r.status).toBe(200);const j=await r.json();
expect(j.cities.find((c:any)=>c.name==='Bangalore').topCompanies).toEqual(['Real Co']);
expect(j.worldwideRemote.topCompanies).toEqual(['Real Co']);expect(j.header.totalActive).toBe(10);
});
