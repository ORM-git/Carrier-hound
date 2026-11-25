import { describe,it,expect,vi } from 'vitest';
vi.mock('@/lib/onboarding/resumeParse',()=>({readResumeProfileForRanking:vi.fn(async()=>({status:'missing'}))}));
vi.mock('@/config/onboarding',()=>({isOnboardingStep2EnabledServer:()=>false}));
import {loadDisplayScoreAnswers,sharedDisplayScore} from '../displayScore';
import {scoreJobRecommendation} from '../recommendations';
import {clampMatchScore} from '@/lib/matcher/scoring';
const row={id:'51dbea38-a70d-4de8-a940-f18f0eca6ed7',title:'Frontend Engineer',remote:true,remote_scope:'worldwide',job_type:'full-time',country_code:'US',location:'Remote',category:'engineering',description:'React TypeScript applications',skills:['React','TypeScript'],posted_at:'2026-11-01'};
const prefs={roles:['Frontend Engineer'],experience_level:'mid',remote_preference:'remote',locations:['United States'],employment_types:['full-time']};
function db(data:any,error:any=null){const eq=vi.fn(()=>({maybeSingle:async()=>({data,error})}));return {from:vi.fn(()=>({select:()=>({eq})})),eq};}
describe('one display score across feed/detail/reload',()=>{
 it('loads only the authenticated user saved profile and computes the identical server score on all routes',async()=>{const store=db(prefs);const answers=await loadDisplayScoreAnswers(store,'user-a');expect(store.eq).toHaveBeenCalledWith('user_id','user-a');const feed=sharedDisplayScore(row,answers);const detail=sharedDisplayScore({...row},await loadDisplayScoreAnswers(store,'user-a'));const reload=sharedDisplayScore(JSON.parse(JSON.stringify(row)),await loadDisplayScoreAnswers(store,'user-a'));expect(feed).toBe(clampMatchScore(scoreJobRecommendation(row,answers!).score));expect([feed,detail,reload]).toEqual([feed,feed,feed]);});
 it('does not invent a guest score or use a failed/empty preferences read',async()=>{const store=db(null);expect(await loadDisplayScoreAnswers(store,null)).toBeNull();expect(store.from).not.toHaveBeenCalled();expect(await loadDisplayScoreAnswers(store,'user')).toBeNull();expect(await loadDisplayScoreAnswers(db(prefs,{message:'offline'}),'user')).toBeNull();expect(sharedDisplayScore(row,null)).toBeNull();});
 it('changes all surfaces together after a profile update, without localStorage',async()=>{const a=await loadDisplayScoreAnswers(db(prefs),'user');const b=await loadDisplayScoreAnswers(db({...prefs,roles:['Finance Manager'],remote_preference:'onsite'}),'user');expect(sharedDisplayScore(row,a)).not.toBe(sharedDisplayScore(row,b));});
});
