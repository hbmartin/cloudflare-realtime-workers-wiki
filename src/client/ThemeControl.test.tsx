// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeControl } from "./ThemeControl";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  });
  document.documentElement.setAttribute("data-mantine-color-scheme", "dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-mantine-color-scheme");
});

it("toggles away from the visible system theme", () => {
  render(<ThemeControl compact />);
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(localStorage.getItem("notes:color-scheme")).toBe("light");
});
