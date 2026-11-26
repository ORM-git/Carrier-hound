// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AppTopBar from "../AppTopBar";
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/session", () => ({ signOutUser: vi.fn() }));
afterEach(cleanup);
describe("shared mobile app brand", () => {
  it.each(["SETTINGS", "JOBS", "PROFILE", "RESUME", "TRACKER", "RADAR", "PRICING"])("keeps the brand home link and page identity on %s", (pageLabel) => {
    render(<AppTopBar pageLabel={pageLabel} />);
    const brand=screen.getByTestId("app-mobile-brand");
    expect(brand.getAttribute("href")).toBe("/jobs");
    expect(brand.getAttribute("aria-label")).toBe("Career Monke Jobs");
    expect(brand.textContent).toBe("career monke");
    expect(screen.getByRole("heading", { name: pageLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    expect(screen.getByRole("button", { name: "Close navigation menu" })).toBeTruthy();
  });
  it("preserves compact Jobs tabs alongside the brand", () => {
    const click=vi.fn();
    render(<AppTopBar pageLabel="JOBS" mobileTabs={[{id:"recommended",label:"For You",active:true,onClick:click},{id:"saved",label:"Saved",count:0,active:false,onClick:click},{id:"applied",label:"Applied",count:0,active:false,onClick:click}]} />);
    expect(screen.getByTestId("app-mobile-brand")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "For You" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Saved\s*0/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Applied\s*0/ })).toBeTruthy();
  });
});
