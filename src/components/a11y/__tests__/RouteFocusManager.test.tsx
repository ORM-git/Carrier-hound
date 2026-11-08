// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

let mockPathname = "/login";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import RouteFocusManager from "../RouteFocusManager";

function makeDom() {
  const main = document.createElement("main");
  main.id = "m";
  main.textContent = "content";
  const host = document.createElement("div");
  host.id = "host";
  document.body.appendChild(main);
  document.body.appendChild(host);
}

function clearDom() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

function renderInto(container: HTMLElement) {
  const root = createRoot(container);
  act(() => {
    root.render(createElement(RouteFocusManager));
  });
  return root;
}

describe("RouteFocusManager (row 32)", () => {
  it("does not steal focus on initial load", () => {
    clearDom();
    makeDom();
    mockPathname = "/login";
    renderInto(document.getElementById("host")!);
    expect(document.activeElement?.id).not.toBe("m");
  });

  it("focuses the main landmark on route change, without scroll", () => {
    clearDom();
    makeDom();
    mockPathname = "/login";
    const root = renderInto(document.getElementById("host")!);
    const main = document.getElementById("m")!;
    const focusSpy = vi.spyOn(main, "focus");
    mockPathname = "/jobs";
    act(() => {
      root.render(createElement(RouteFocusManager));
    });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.style.outlineStyle).toBe("none");
  });

  it("renders nothing", () => {
    clearDom();
    const host = document.createElement("div");
    host.id = "host";
    document.body.appendChild(host);
    mockPathname = "/x";
    renderInto(host);
    expect(host.childNodes.length).toBe(0);
  });
});
