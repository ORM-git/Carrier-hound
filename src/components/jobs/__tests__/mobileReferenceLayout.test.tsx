// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import JobCardContent from '../JobCardContent';
vi.mock('next/link', () => ({ default: ({children,...p}:any) => <a {...p}>{children}</a> }));
afterEach(cleanup);
const job:any={id:'fixture',title:'Fixture engineer',company:'Fixture',location:'Remote',date:'',salary:'',category:'engineering',remote:true,country:'',type:'Full-time',directSource:true,applyUrl:'https://fixture.invalid/apply'};
it('phone card omits duplicate Apply but keeps save/menu actions and card detail entry owned by caller',()=>{
 const save=vi.fn(), select=vi.fn();
 const r=render(<article role="button" tabIndex={0} onClick={select} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select();}}}><JobCardContent job={job} index={0} isPro isSaved={false} matchScore={76} cardZeroSkills={false} isRecent={false} postedRelative="2 days ago" companyPills={[]} locInfo={{primary:'Remote',extraCount:0,all:[]}} jobLevel="Senior Level" formattedJobType="Full-time" getTagColorClass={()=>''} formatRelativeTime={()=>'2 days ago'} handleHideJob={vi.fn()} handleToggleApplied={vi.fn()} handleSaveJob={save} handleSelectJob={vi.fn()} handleLockedAction={vi.fn()}/></article>);
 const mobile=within(r.getByTestId('mobile-reference-card'));
 expect(mobile.getByRole('button',{name:/^Apply$/}).getAttribute('data-mobile-list-apply')).toBe('true');
 expect(readFileSync('src/app/jobs/mobile-reference.css','utf8')).toContain('.cm-jobs-reference [data-mobile-list-apply] { display: none; }');
 fireEvent.click(mobile.getByRole('button',{name:'Save job'}));expect(save).toHaveBeenCalledWith(job);expect(select).not.toHaveBeenCalled();
 fireEvent.click(mobile.getByRole('heading',{name:'Fixture engineer'}));expect(select).toHaveBeenCalledOnce();
});
describe('phone cosmetic scope',()=>{
 it('all reference CSS is bounded below640px, no desktop selector escapes',()=>{
  const css=readFileSync('src/app/jobs/mobile-reference.css','utf8');
  expect(css.match(/@media/g)).toHaveLength(4);expect(css.match(/@media \(max-width: 639px\)/g)).toHaveLength(3);
  let depth=0;for(const line of css.split('\n')){if(line.trim().startsWith('.cm-'))expect(depth).toBeGreaterThan(0);depth+=(line.match(/\{/g)||[]).length-(line.match(/\}/g)||[]).length;}expect(depth).toBe(0);
 });
 it('retains original tablet/desktop Apply label while using phone APPLY NOW and selected tab state',()=>{
  const d=readFileSync('src/components/jobs/JobDetailView.tsx','utf8');expect(d).toContain('<span className="sm:hidden">APPLY NOW</span><span className="hidden sm:inline">Apply</span>');expect(d).toContain('aria-pressed={activeTab === "company"}');
 });
});

it('uses CM blue instead of reference green for phone accents',()=>{
 const css=readFileSync('src/app/jobs/mobile-reference.css','utf8');
 expect(css).toContain('background: #2563eb; color: #fff');
 expect(css).toContain('stop-color: #2563eb');
 expect(css).not.toMatch(/#00dba0|#97f8e7|#8cecc2|#d8fbc8|#e3faf3/);
});

it('phone density shows CM arrival age bottom-left, keeps action row, and bolds filter navigation',()=>{
 const css=readFileSync('src/app/jobs/mobile-reference.css','utf8');
 expect(css).toContain('> div:last-child > span { margin-right: auto;');
 expect(css).not.toContain('> div:last-child > span { display: none; }');
 expect(css).toContain('padding-top: 0; border-color: transparent; gap: 6px; justify-content: flex-end;');
 expect(css).toContain('font-weight: 700; justify-content: flex-start');
 expect(css).toContain('transparent; padding: 12px;');
});
