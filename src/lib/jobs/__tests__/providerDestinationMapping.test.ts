import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyApplyDestination } from "../applyDestination";
import { ArbeitnowAdapter } from "../../../../scripts/adapters/arbeitnow";
import { AdzunaAdapter } from "../../../../scripts/adapters/adzuna";
import { RemotiveAdapter } from "../../../../scripts/adapters/remotive";
import { RemoteOKAdapter } from "../../../../scripts/adapters/remoteok";
const mock=vi.hoisted(()=>({body:{} as any}));
vi.mock("../../../../scripts/utils/polite-fetch",()=>({politeFetchJson:async()=>mock.body}));
afterEach(()=>vi.unstubAllEnvs());
const ATS="https://boards.greenhouse.io/stripe/jobs/123";
describe("actual aggregator adapters keep provenance separate from application URL",()=>{
 const cases=[
  ["arbeitnow",ArbeitnowAdapter,()=>({data:[{slug:"j",title:"Engineer",company_name:"Stripe",location:"London",remote:false,url:ATS,description:"Build things"}]})],
  ["adzuna",AdzunaAdapter,()=>({results:[{id:"j",title:"Engineer",company:{display_name:"Stripe"},location:{display_name:"London"},redirect_url:ATS,description:"Build things"}]})],
  ["remotive",RemotiveAdapter,()=>({jobs:[{id:"j",title:"Engineer",company_name:"Stripe",candidate_required_location:"London",url:ATS,description:"Build things"}]})],
  ["remoteok",RemoteOKAdapter,()=>[{id:"j",position:"Engineer",company:"Stripe",location:"London",url:"https://remoteok.com/remote-jobs/j",apply_url:ATS,description:"Build things"}]],
 ] as const;
 for(const [source,Adapter,fixture] of cases)it(source,async()=>{
  vi.stubEnv("ADZUNA_APP_ID","test");vi.stubEnv("ADZUNA_APP_KEY","test");mock.body=fixture();
  const rows=await new Adapter().fetchJobs({type:source,name:source,target:source==="adzuna"?"gb":undefined} as any);
  expect(rows.length).toBe(1);expect(rows[0].source).toBe(source);expect(rows[0].source_type).toBe("feed");expect(rows[0].apply_url).toBe(ATS);
  expect(classifyApplyDestination(rows[0].apply_url).kind).toBe("employer_board");
 });
});
