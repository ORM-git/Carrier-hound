import { describe,it,expect } from 'vitest';
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const root=process.cwd(),read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8');
describe('existing fonts bundled without build-time Google requests',()=>{
 it('retains variable names, weights, unicode faces, swap and exact fallback metrics',()=>{
  const inter=read('src/styles/inter-local.css'),jakarta=read('src/styles/jakarta-local.css');
  for(let w=100;w<=900;w+=100)expect(inter).toContain(`font-weight: ${w};`);
  for(let w=400;w<=800;w+=100)expect(jakarta).toContain(`font-weight: ${w};`);
  expect(inter.match(/unicode-range:/g)).toHaveLength(63);expect(jakarta.match(/unicode-range:/g)).toHaveLength(20);
  expect(inter).toContain("--font-inter:'Inter','Inter Fallback'");expect(jakarta).toContain("--font-cm-jakarta:'Plus Jakarta Sans'");
  for(const v of ['90.49%','22.56%','107.06%'])expect(inter).toContain(v);
  for(const css of [inter,jakarta]){expect(css).toContain('font-display: swap');expect(css).not.toContain('https:');}
  expect(jakarta).not.toContain('size-adjust');
 });
 it('checks every font signature/hash and retains both OFL notices',()=>{
  const sources=JSON.parse(read('public/fonts/sources.json'));expect(sources).toHaveLength(11);
  for(const a of sources){const b=fs.readFileSync(path.join(root,a.file));expect(b.subarray(0,4).toString()).toBe('wOF2');expect(createHash('sha256').update(b).digest('hex')).toBe(a.sha256);expect(a.url.startsWith('https://fonts.gstatic.com/')).toBe(true);}
  for(const d of ['inter','plus-jakarta-sans'])expect(read(`public/fonts/${d}/OFL.txt`)).toContain('SIL OPEN FONT LICENSE');
 });
 it('has no Google font loader at site entrypoints and retains selected subset preloads',()=>{
  const layout=read('src/app/layout.tsx'),page=read('src/app/page.tsx');
  for(const s of[layout,page])expect(s).not.toContain('next/font/google');
  expect(layout).toContain('/fonts/inter/inter-6.woff2');expect(page).toContain('/fonts/plus-jakarta-sans/plus-jakarta-sans-2.woff2');expect(page).toContain('/fonts/plus-jakarta-sans/plus-jakarta-sans-3.woff2');
 });
});
