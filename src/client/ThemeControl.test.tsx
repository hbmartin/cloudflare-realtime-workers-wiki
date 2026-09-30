// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeCommand, ThemeControl } from "./ThemeControl";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  });
  document.documentElement.setAttribute("data-mantine-color-scheme", "dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-mantine-color-scheme");
});

it("toggles away from the visible system theme", () => {
  const view = render(<ThemeCommand />);
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(localStorage.getItem("notes:color-scheme")).toBe("light");
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(localStorage.getItem("notes:color-scheme")).toBe("dark");
  view.unmount();
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(localStorage.getItem("notes:color-scheme")).toBe("dark");
});

it("shares command and control changes without a provider or writable storage", () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage denied");
  });
  render(
    <>
      <ThemeCommand />
      <ThemeControl compact />
      <ThemeControl />
    </>,
  );
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Theme: Light. Change theme" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(screen.getByRole("button", { name: "Theme: Dark. Change theme" })).toBeVisible();
  act(() => {
    window.dispatchEvent(new Event("notes:toggle-theme"));
  });
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
});
