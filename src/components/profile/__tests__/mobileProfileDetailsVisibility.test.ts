import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
describe('phone Profile lower-section scope',()=>{
 it('hides only the desktop details container below sm, retaining source cards and all saved-data handlers',()=>{
 const source=fs.readFileSync('src/app/profile/page.tsx','utf8');
 expect(source).toContain('data-testid="desktop-profile-details" className="hidden sm:block max-w-6xl');
 expect(source.indexOf('MobileProfileSources key=')).toBeLessThan(source.indexOf('data-testid="desktop-profile-details"'));
 for(const id of ['profile-section-experience','profile-section-education','profile-section-skills'])expect(source).toContain(id);
 expect(source).toContain('handleOpenDrawer');
 });
});
