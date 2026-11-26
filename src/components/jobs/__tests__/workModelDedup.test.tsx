// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {LiveJob} from '@/lib/jobs/service';
import JobDetailView from '@/components/jobs/JobDetailView';
import JobCardContent from '@/components/jobs/JobCardContent';
import {isDuplicateWorkModelLocation,workModelDetailLabel} from '@/lib/jobs/workModel';
vi.mock('@/components/CookieNotice',()=>({useCookieNoticeHeight:()=>0}));
vi.mock('@/components/CompanyLogo',()=>({default:()=>null}));
vi.mock('@/components/jobs/JobAiToolsPanel',()=>({default:()=>null}));
const base={id:'dedup',title:'Engineer',company:'Fixture',location:'Remote',remote:true,remoteScope:'remote',salary:'',category:'engineering',country:'US',type:'Full-time',description:'',skills:[],applyUrl:'https://example.test',date:'',directSource:true} as LiveJob;
afterEach(cleanup);
function detail(job:LiveJob,isPro=true){return render(<JobDetailView job={job} candidate={null} user={null} isPro={isPro} isSaved={false} onSave={()=>{}} onApply={()=>{}} onBack={()=>{}}/>);}
function card(job:LiveJob,isPro=true,extraCount=0){return render(<JobCardContent job={job} index={0} isPro={isPro} isSaved={false} matchScore={null} cardZeroSkills={false} isRecent={false} postedRelative={null} companyPills={[]} locInfo={{primary:job.location,extraCount,all:[job.location,'London']}} jobLevel='' formattedJobType='Full-time' getTagColorClass={()=>''} formatRelativeTime={()=>''} handleHideJob={()=>{}} handleToggleApplied={()=>{}} handleSaveJob={()=>{}} handleSelectJob={()=>{}} handleLockedAction={()=>{}}/>);}
it.each([['Remote','remote',true],['  rEmOtE  ','remote',true],['Hybrid','hybrid',false],['On-site','onsite',false]])('detail shows mode only once for %s',(location,remoteScope,remote)=>{detail({...base,location,remoteScope,remote});const facts=within(screen.getByTestId('mobile-job-facts'));expect(facts.getAllByText(/^(remote|hybrid|on-site)$/i)).toHaveLength(1);});
it.each(['Remote UK','Remote (US)','San Francisco'])('detail preserves geography %s',(location)=>{detail({...base,location});const facts=within(screen.getByTestId('mobile-job-facts'));expect(facts.getByText(location)).toBeTruthy();expect(facts.getByText('Remote')).toBeTruthy();});
it('detail preserves regional scope and locked location',()=>{const view=detail({...base,remoteScope:'US'});expect(within(screen.getByTestId('mobile-job-facts')).getByText('Remote (US)')).toBeTruthy();view.unmount();detail(base,false);expect(within(screen.getByTestId('mobile-job-facts')).getByText('Location locked')).toBeTruthy();});
it.each(['hybrid','onsite'])('missing %s location never invents Remote',(remoteScope)=>{detail({...base,location:'',remote:false,remoteScope});const facts=within(screen.getByTestId('mobile-job-facts'));expect(facts.getByText('Location unlisted')).toBeTruthy();expect(facts.queryByText('Remote')).toBeNull();});
it.each(['remote','hybrid','onsite'])('both card variants dedup %s and retain canonical mode',(remoteScope)=>{card({...base,location:remoteScope==='onsite'?'On-site':remoteScope,remote:remoteScope==='remote',remoteScope});expect(screen.getAllByText(/^(remote|hybrid|on-site)$/i)).toHaveLength(2);});
it('cards preserve real geography, additional locations and locks',()=>{let v=card({...base,location:'Remote UK'});expect(screen.getAllByText('Remote UK')).toHaveLength(2);v.unmount();v=card(base,true,1);expect(screen.getAllByText('Remote')).toHaveLength(4);v.unmount();card(base,false);expect(screen.getAllByText('Location locked')).toHaveLength(2);});
it('comparison is exact and never erases geographic or regional scope',()=>{expect(isDuplicateWorkModelLocation(' Remote ','remote')).toBe(true);for(const location of ['Remote UK','Remote (US)','Remote, London','',null])expect(isDuplicateWorkModelLocation(location,'Remote')).toBe(false);expect(isDuplicateWorkModelLocation('Remote','Remote',1)).toBe(false);expect(workModelDetailLabel({...base,remoteScope:'worldwide'})).toBe('Remote (worldwide)');});
