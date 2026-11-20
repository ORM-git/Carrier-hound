import {it,expect,vi} from "vitest";
import {resolvePendingMandates} from "../billing/pendingMandate";
for (const legacy of [true,false]) {
 it(`keeps pending slot unless provider confirms mandate cannot charge: legacy=${legacy}`,async()=>{
 const row:any={id:"po_old",provider:"razorpay",provider_order_id:"sub_old",plan_code:"weekly",mode:"test",created_at:new Date(Date.now()-3600000).toISOString(),metadata:legacy?{}:{expire_by:Math.floor(Date.now()/1000)-120}};
 const updates:any[]=[];
 const chain:any={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,maybeSingle:async()=>({data:row,error:null}),update:(v:any)=>{updates.push(v);return chain;},then:(r:any)=>r({error:null})};
 const fetchFn=vi.fn(async()=>new Response(JSON.stringify({error:"provider unavailable"}),{status:503}));
 const d=await resolvePendingMandates({supabaseAdmin:{from:()=>chain},userId:"u",planCode:"quarterly",mode:"test",gateway:{keyId:"test",keySecret:"test",fetchFn:fetchFn as any}});
 console.log("EXPIRY_REVIEW",{legacy,decision:d,updates,calls:fetchFn.mock.calls.length});
 expect(d.kind).toBe("conflict");
 });
}
