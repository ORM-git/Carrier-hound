import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({env:{CM_PREFERRED_SKILLS_RANKING:'1',NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS:'true',SUPABASE_SERVICE_ROLE_KEY:'fixture'}}));
vi.mock('@cloudflare/next-on-pages',()=>({getRequestContext:()=>({env:state.env})}));
it('reviewer CF gate matches loader readiness',async()=>{
 delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS;
 const {GET}=await import('../capabilities/route');
 const caps=await(await GET()).json();
 expect(caps.savedConstraintsApplied).toBe(true);
 expect(caps.preferredSkillsRanking).toBe(true);
});
