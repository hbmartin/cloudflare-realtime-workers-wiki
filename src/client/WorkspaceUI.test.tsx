// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("wraps keyboard focus and focuses an action enabled after opening", async () => {
    const user = userEvent.setup();
    const view = render(
      <ActionMenu label="Space options">
        <button disabled>Watch</button>
      </ActionMenu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Space options" }));
    expect(document.querySelector(".action-menu-portal")).toHaveFocus();
    view.rerender(
      <ActionMenu label="Space options">
        <button>Watch</button>
        <button>Other</button>
      </ActionMenu>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Watch" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Other" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Watch" })).toHaveFocus();
  });
  it("blocks a repeated Enter on the open action and after closing it", () => {
    render(
      <ActionMenu label="Page options">
        <button data-close-menu>Move to trash</button>
      </ActionMenu>,
    );
    const summary = screen.getByRole("button", { name: "Page options" });
    fireEvent.click(summary);
    const action = screen.getByRole("button", { name: "Move to trash" });
    const heldOnAction = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    action.dispatchEvent(heldOnAction);
    expect(heldOnAction.defaultPrevented).toBe(true);
    fireEvent.click(action);
    expect(summary).toHaveFocus();
    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    summary.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(document.querySelector(".action-menu-portal")).toBeNull();
  });
});
