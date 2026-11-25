// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MobileFilterSheet from "../MobileFilterSheet";
afterEach(cleanup);
const filters:any={location:"",category:"",level:"",jobType:"",workModel:"",datePosted:"all",hidden:true,sort:"match"};
it("phone removes hidden entrypoints, badge and applied hidden-only state without changing stored ids",()=>{
 const apply=vi.fn();render(<MobileFilterSheet isOpen onClose={()=>{}} filters={filters} onApply={apply} onResetAll={()=>{}} activeCount={1} hiddenCount={4} hideHiddenJobs/>);
 expect(screen.queryByLabelText("View Hidden Positions")).toBeNull();
 expect(screen.queryByText("Hidden Jobs")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/show.*jobs|apply/i}));
 expect(apply.mock.calls[0][0].hidden).toBe(false);
});
it("non-phone filter sheet keeps existing hidden control and state",()=>{
 render(<MobileFilterSheet isOpen onClose={()=>{}} filters={filters} onApply={()=>{}} onResetAll={()=>{}} activeCount={1} hiddenCount={4}/>);
 expect(screen.getByLabelText("View Hidden Positions").getAttribute("aria-checked")).toBe("true");
});
