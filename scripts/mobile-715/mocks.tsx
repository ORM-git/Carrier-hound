import React,{useState} from 'react';
export const user={id:'fixture-user',email:'fixture@example.test',user_metadata:{},app_metadata:{},aud:'authenticated',created_at:'2026-01-01'};
export const prefs={roles:['Frontend Engineer'],categories:['engineering'],employmentTypes:['full-time'],locations:['United States'],remotePreference:'remote',experienceLevel:'mid',onboardingCompleted:true,dailyDigestOptIn:false,updatedAt:'2026-11-24'};
export const candidate={name:'Fixture',email:'fixture@example.test',phone:'',headline:'Frontend Engineer',summary:'Frontend applications',skills:['React','TypeScript'],experience:[],education:[],certifications:[],confirmedAt:'2026-11-24',updatedAt:'2026-11-24'};
const state=()=>new URLSearchParams(location.search).get('state')||'populated';
export const job={id:'51dbea38-a70d-4de8-a940-f18f0eca6ed7',title:'Frontend Engineer, Developer Experience',company:'Synthetic Employer',location:'San Francisco, United States',country:'US',category:'engineering',remote:true,remoteScope:'hybrid',type:'Full-time',directSource:true,applyUrl:'https://example.test/apply',salary:'₹1,23,45,678 - ₹1,98,76,543 /year',salary_original:'USD $148,000 - $237,500 per year',description:'Build accessible frontend applications with React and TypeScript. Collaborate with product and design teams.',skills:['React','TypeScript'],date:'Today',postedAt:'2026-11-24T06:00:00Z',matchScore:83,scoreRevision:'fixture.v1',logoUrl:'https://protected.example.test/logo.png'};
export async function getLiveJobs(options:any){(window as any).__feedCalls=[...((window as any).__feedCalls||[]),options.page];if(state()==='loading')return new Promise(()=>{});if(state()==='error')return {jobs:[],totalCount:0,isDegraded:true};const page=options.page||1;if(page>1&&state()==='page-error')throw Error('Fixture next-page error');const jobs=state()==='empty'?[]:Array.from({length:page===1?25:5},(_,i)=>({...job,id:i===0&&page===1?job.id:`fixture-${page}-${i}`}));return {jobs,totalCount:30,hasNextPage:state()==='paging'||state()==='page-error'?page<3:false,nextCursor:`fixture-${page}`};}
export async function getLiveJobById(){return {...job};}
export function isEarlyApplicant(){return true;}
export const capJobsPerCompany=(j:any)=>j;
export const getAuthUser=async()=>state()==='guest'?null:user;
export const getUserPreferences=async()=>prefs;
export const signOutUser=async()=>{};
export const getCandidateProfile=async()=>candidate;
export const getProAccessStatus=async()=>({isPro:state()!=='guest'&&state()!=='free',isDefinitive:true,source:'fixture'});
export const getTrackedApplications=async()=>state()==='applied'?[{id:'app1',jobId:job.id,title:job.title,company:job.company,stage:'applied',status:'applied'}]:[];
export const isMatchingTrackerJob=()=>false;
export const addApplicationToTracker=async()=>{};export const removeApplicationFromTracker=async()=>{};export const updateApplicationStage=async()=>{};export const quickTrackJob=async()=>{};
export const getValidReturnUrl=(s:string,f='/jobs')=>s?.startsWith('/')&&!s.startsWith('//')?s:f;
export const createClient=()=>({auth:{getSession:async()=>({data:{session:null}}),signInWithPassword:async()=>({error:{code:'invalid_credentials'}}),signUp:async()=>({data:{session:null}}),signInWithOAuth:async()=>({}),resetPasswordForEmail:async()=>({}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}});
export const trackFunnelEvent=()=>{};export const handleProCheckout=async(...args:any[])=>{(window as any).__checkout=args;return {ok:false,error:'Fixture cancelled'};};export const openRazorpaySubscription=handleProCheckout;
export const useRouter=()=>({push:(url:string)=>location.href=url,replace:(url:string)=>history.replaceState({},'',url),back:()=>history.back()});export const usePathname=()=>new URLSearchParams(location.search).get('view')==='landing'?'/':location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);
export function Link({href,children,prefetch,...props}:any){return <a href={href} {...props}>{children}</a>;}export function Image({priority,fill,unoptimized,...p}:any){return <img {...p}/>;}
export function Dynamic(){return ()=>null;}
export function Shell({children}:any){return <>{children}</>;}
export const mockFetch=async()=>new Response(JSON.stringify({fileName:'fixture.pdf',linkedinUrl:'https://linkedin.com/in/fixture',parse:{status:'parsed'}}),{status:200,headers:{'content-type':'application/json'}});

export class LatestJobSelectionGate { private serial=0; begin(){return ++this.serial;} isCurrent(token:number){return token===this.serial;} cancel(){this.serial++;} }
