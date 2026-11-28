// @vitest-environment jsdom
// Superseded refresh must not authorise a commit (race regression; adapted from an independent review test).
import {renderHook,act} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
import {useRequiredYearsCapability} from '../useRequiredYearsCapability';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()});
it('superseded successful refresh cannot authorize commit after newer failed refresh',async()=>{
 vi.stubEnv('NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS','true');let pending:((v:Response)=>void)[]=[];
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>pending.push(r))));
 const {result,unmount}=renderHook(()=>useRequiredYearsCapability());
 await act(async()=>{pending.shift()!(new Response(JSON.stringify({requiredYearsFilter:true})));});
 let a!:Promise<boolean>,b!:Promise<boolean>;
 act(()=>{a=result.current.refresh();b=result.current.refresh()});
 await act(async()=>{pending[1](new Response(JSON.stringify({requiredYearsFilter:false})));await b;});
 expect(result.current.ready).toBe(false);
 let authorization:boolean|undefined;
 await act(async()=>{pending[0](new Response(JSON.stringify({requiredYearsFilter:true})));authorization=await a;});
 expect(result.current.ready).toBe(false);
 expect(authorization).toBe(false);unmount();
});

it('leaves no pending timers after a fast success, a rejection, a superseded check or unmount', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    vi.stubEnv('NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS', 'true');
    let body: unknown = { requiredYearsFilter: true };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const { result, unmount } = renderHook(() => useRequiredYearsCapability());
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    expect(result.current.ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    body = { requiredYearsFilter: false };
    await act(async () => { await result.current.refresh(); });
    expect(result.current.ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    await act(async () => { await result.current.refresh(); });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
