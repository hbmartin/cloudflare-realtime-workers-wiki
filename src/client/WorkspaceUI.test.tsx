// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActionMenu } from "./WorkspaceUI";

describe("ActionMenu keyboard focus", () => {
  it("focuses the first enabled portaled button and restores focus on explicit close", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ActionMenu label="Page details">
          <button disabled>Unavailable</button>
          <button>First action</button>
          <button data-close-menu>Second action</button>
        </ActionMenu>
        <button>Outside</button>
      </>,
    );
    const summary = screen.getByRole("button", { name: "Page details" });
    summary.focus();

    // jsdom does not synthesize summary's native click from Enter.
    fireEvent.click(summary);
    expect(document.querySelector(".action-menu-portal")).not.toBeNull();
    expect(screen.getByRole("button", { name: "First action" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Second action" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(summary).toHaveFocus();
    expect(document.querySelector(".action-menu-portal")).toBeNull();

    fireEvent.click(summary);
    await user.click(screen.getByRole("button", { name: "Second action" }));
    expect(summary).toHaveFocus();
    expect(document.querySelector(".action-menu-portal")).toBeNull();

    fireEvent.click(summary);
    await user.click(summary);
    expect(summary).toHaveFocus();
    expect(document.querySelector(".action-menu-portal")).toBeNull();

    fireEvent.click(summary);
    const outside = screen.getByRole("button", { name: "Outside" });
    await user.click(outside);
    expect(outside).toHaveFocus();
    expect(document.querySelector(".action-menu-portal")).toBeNull();
  });
});
