// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { SlackChannelPicker } from "./SlackChannelPicker";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("SlackChannelPicker", () => {
  it("searches subsequent directory pages and submits canonical channel IDs", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.includes("cursor=")
        ? { channels: [{ id: "C2", name: "later-match", private: true }], nextCursor: null }
        : { channels: [{ id: "C1", name: "first", private: false }], nextCursor: "second" },
    );
    render(<SlackChannelPicker />);
    await screen.findByRole("option", { name: "#first" });
    fireEvent.change(screen.getByLabelText("Search Slack channels"), { target: { value: "match" } });
    const option = await screen.findByRole("option", { name: "Private #later-match" });
    expect(option).toHaveValue("C2");
    expect(screen.queryByRole("option", { name: "#first" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Slack channel"), { target: { value: "C2" } });
    expect(screen.getByLabelText("Slack channel")).toHaveValue("C2");
    expect(api).toHaveBeenCalledWith("/api/slack/channel-directory?cursor=second");
  });
  it("allows refreshing after the bot joins an empty directory", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ channels: [], nextCursor: null })
      .mockResolvedValueOnce({ channels: [{ id: "C1", name: "joined", private: false }], nextCursor: null });
    render(<SlackChannelPicker />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh channels" }));
    expect(await screen.findByRole("option", { name: "#joined" })).toBeInTheDocument();
  });
  it("shows retryable errors without silently continuing pagination", async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("Missing channels:read"))
      .mockResolvedValue({ channels: [], nextCursor: null });
    render(<SlackChannelPicker />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
