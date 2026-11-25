// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSheetPresence } from "../hooks/useSheetPresence";
function Sheet({ open }: { open: boolean }) { const { present, exiting } = useSheetPresence(open); return present ? <div data-testid="sheet" data-exiting={String(exiting)} /> : null; }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.style.overflow = ""; });
it("retains exit for 300ms, locks scroll, handles a reopen and clears timers", () => {
 vi.useFakeTimers(); const view=render(<Sheet open />); expect(document.body.style.overflow).toBe("hidden");
 view.rerender(<Sheet open={false}/>); expect(screen.getByTestId("sheet").dataset.exiting).toBe("true");
 act(()=>{vi.advanceTimersByTime(150)}); view.rerender(<Sheet open/>); act(()=>{vi.advanceTimersByTime(400)});
 expect(screen.getByTestId("sheet").dataset.exiting).toBe("false");
 view.rerender(<Sheet open={false}/>); act(()=>{vi.advanceTimersByTime(299)}); expect(screen.getByTestId("sheet")).toBeTruthy();
 act(()=>{vi.advanceTimersByTime(1)}); expect(screen.queryByTestId("sheet")).toBeNull(); expect(document.body.style.overflow).toBe(""); view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("removes a reduced-motion exit on the next tick with no visual movement",()=>{
 vi.useFakeTimers(); vi.stubGlobal("matchMedia",()=>({matches:true})); const view=render(<Sheet open/>); view.rerender(<Sheet open={false}/>); act(()=>{vi.advanceTimersByTime(0)});expect(screen.queryByTestId("sheet")).toBeNull();
});

it("shares lock ownership across overlapping closing/opening consumers", () => {
 vi.useFakeTimers(); document.body.style.overflow = "auto";
 const view=render(<><Sheet open/><Sheet open={false}/></>);
 view.rerender(<><Sheet open={false}/><Sheet open/></>);
 act(()=>{vi.advanceTimersByTime(300)}); expect(document.body.style.overflow).toBe("hidden");
 view.rerender(<><Sheet open={false}/><Sheet open={false}/></>);
 act(()=>{vi.advanceTimersByTime(300)}); expect(document.body.style.overflow).toBe("auto");
 view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

import PreferencesSheet from "../PreferencesSheet";
import MobileFilterSheet from "../MobileFilterSheet";
import { emptyUserPreferences } from "@/lib/auth/types";
it("real Preferences and Filters keep the shared lock through a cross-sheet close/open", () => {
 vi.useFakeTimers(); document.body.style.overflow="auto";
 const filters:any={location:"",category:"",level:"",jobType:"",workModel:"",datePosted:"all",hidden:false,sort:"match"};
 const pair=(a:boolean,b:boolean)=><><PreferencesSheet isOpen={a} ownerId="owner" onClose={()=>{}} committed={emptyUserPreferences()} onSave={async()=>{}}/><MobileFilterSheet isOpen={b} onClose={()=>{}} filters={filters} onApply={()=>{}} onResetAll={()=>{}} activeCount={0} hiddenCount={0}/></>;
 const view=render(pair(true,false));view.rerender(pair(false,true));
 expect(document.querySelector('[data-testid="preferences-sheet"]')?.getAttribute('aria-hidden')).toBe('true');
 expect(screen.getByRole('dialog',{name:'Filter positions'})).toBeTruthy();
 act(()=>{vi.advanceTimersByTime(300)});expect(document.body.style.overflow).toBe('hidden');
 view.rerender(pair(false,false));act(()=>{vi.advanceTimersByTime(300)});expect(document.body.style.overflow).toBe('auto');
 view.unmount();
});
