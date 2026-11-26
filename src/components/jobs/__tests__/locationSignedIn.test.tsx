// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import type {LiveJob} from '@/lib/jobs/service';
import JobDetailView from '@/components/jobs/JobDetailView';
import JobCardContent from '@/components/jobs/JobCardContent';

vi.mock('@/components/CookieNotice',()=>({useCookieNoticeHeight:()=>0}));
vi.mock('@/components/CompanyLogo',()=>({default:()=>null}));
vi.mock('@/components/jobs/JobAiToolsPanel',()=>({default:()=>null}));
const base={id:'dedup',title:'Engineer',company:'Fixture',location:'Remote',remote:true,remoteScope:'remote',salary:'',category:'engineering',country:'US',type:'Full-time',description:'',skills:[],applyUrl:'https://example.test',date:'',directSource:true} as LiveJob;
afterEach(cleanup);
const sheet = { id: 'u1', email: 'a@b.test' } as any;
function detail(job: LiveJob, isPro: boolean, user: any) { return render(<JobDetailView job={job} candidate={null} user={user} isPro={isPro} isSaved={false} onSave={() => {}} onApply={() => {}} onBack={() => {}} />); }
function card(job: LiveJob, isPro: boolean, locationVisible?: boolean, extraCount = 0) { return render(<JobCardContent job={job} index={0} isPro={isPro} locationVisible={locationVisible} isSaved={false} matchScore={null} cardZeroSkills={false} isRecent={false} postedRelative={null} companyPills={[]} locInfo={{ primary: job.location, extraCount, all: [job.location, 'London'] }} jobLevel='' formattedJobType='Full-time' getTagColorClass={() => ''} formatRelativeTime={() => ''} handleHideJob={() => {}} handleToggleApplied={() => {}} handleSaveJob={() => {}} handleSelectJob={() => {}} handleLockedAction={() => {}} />); }
const job = { ...base, location: 'Austin, TX' } as LiveJob;
it('card: signed-in Free sees location and +N, company stays masked', () => {
  card(job, false, true, 2);
  expect(screen.queryByText('Location locked')).toBeNull();
  expect(screen.getAllByText('Austin, TX').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Verified Employer').length).toBeGreaterThan(0);
  expect(screen.queryByText('Fixture')).toBeNull();
});
it('card: guest keeps the location lock', () => { card(job, false, false); expect(screen.getAllByText('Location locked').length).toBeGreaterThan(0); expect(screen.queryByText('Austin, TX')).toBeNull(); });
it('card: default follows isPro (landing preview and Pro unchanged)', () => { card(job, true); expect(screen.queryByText('Location locked')).toBeNull(); cleanup(); card(job, false); expect(screen.getAllByText('Location locked').length).toBeGreaterThan(0); });
it('card: signed-in Free dedups pure Remote exactly like Pro', () => { const r = { ...base, location: 'Remote' } as LiveJob; card(r, true); const pro = screen.getAllByText('Remote').length; cleanup(); card(r, false, true); expect(screen.queryByText('Location locked')).toBeNull(); expect(screen.getAllByText('Remote')).toHaveLength(pro); });
it('detail: signed-in Free sees location, employer stays masked', () => {
  detail(job, false, sheet);
  expect(screen.queryByText('Location locked')).toBeNull();
  expect(screen.getAllByText('Austin, TX').length).toBeGreaterThan(0);
  expect(screen.queryByText('Fixture')).toBeNull();
});
it('detail: guest keeps the location lock', () => { detail(job, false, null); expect(screen.getAllByText('Location locked').length).toBeGreaterThan(0); expect(screen.queryByText('Austin, TX')).toBeNull(); });
