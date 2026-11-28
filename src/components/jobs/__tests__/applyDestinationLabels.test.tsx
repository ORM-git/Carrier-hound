// @vitest-environment jsdom
import React from "react";
import { render, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import JobCardContent from "../JobCardContent";
import { classifyApplyDestination, applyDestinationLabel } from "@/lib/jobs/applyDestination";
vi.mock("next/link", () => ({default: ({children,...p}:any)=><a {...p}>{children}</a>}));
afterEach(cleanup);
const props:any={index:0,isPro:true,isSaved:false,matchScore:75,cardZeroSkills:false,isRecent:false,postedRelative:null,companyPills:[],locInfo:{primary:"London",extraCount:0,all:[]},jobLevel:"",formattedJobType:"Full-time",getTagColorClass:()=>"",formatRelativeTime:()=>"",handleHideJob:vi.fn(),handleToggleApplied:vi.fn(),handleSaveJob:vi.fn(),handleSelectJob:vi.fn(),handleLockedAction:vi.fn()};
const base:any={id:"a",title:"Engineer",company:"Company",location:"London",date:"",salary:"",category:"engineering",remote:false,country:"GB",type:"Full-time",directSource:true};
describe("source provenance never becomes verified apply-destination claims",()=>{
 it.each([
  ["https://www.indeed.com/viewjob?jk=x","Aggregator link"],
  ["https://boards.greenhouse.io/stripe/jobs/123","Registered ATS link"],
  ["https://careers.example.org/job","Unverified apply link"],
 ])("desktop and phone label the initial URL %s, not provider/verified flags",(url,label)=>{
   const r=render(<JobCardContent {...props} job={{...base,applyUrl:url,applyDestination:{kind:"employer_board",domain:"spoofed"}}}/>);
   expect(r.getByTestId("desktop-apply-destination").textContent).toBe(label);
   expect(r.getByTestId("mobile-apply-destination").textContent).toBe(label);
   expect(r.queryByText("Verified Direct")).toBeNull();expect(r.queryByText("Direct Feed")).toBeNull();
   expect(r.getByText("Source Feed")).toBeTruthy();
 });
 it("Free and guests never derive or show a protected URL label from a leaked/stale object",()=>{
  const r=render(<JobCardContent {...props} isPro={false} job={{...base,applyUrl:"https://indeed.com/private"}}/>);
  expect(r.queryByTestId("desktop-apply-destination")).toBeNull();expect(r.queryByTestId("mobile-apply-destination")).toBeNull();
 });
 it("source and remote status do not upgrade unknown URLs or unregistered ATS tenants",()=>{
  expect(applyDestinationLabel("https://boards.greenhouse.io/unknown-tenant/jobs/x")).toBe("Unverified apply link");
  expect(classifyApplyDestination("https://indeed.com.attacker.example/job").kind).toBe("unknown");
  expect(applyDestinationLabel("javascript:alert(1)")).toBe("Unverified apply link");
 });
});
