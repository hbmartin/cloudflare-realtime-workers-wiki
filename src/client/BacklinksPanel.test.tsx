// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backlink, Page } from "../shared/types";
import { BacklinksPanel } from "./BacklinksPanel";
import { api } from "./api";

vi.mock("./api", () => ({ api: vi.fn() }));

const page: Page = {
  id: "source-page",
  workspaceId: "workspace",
  spaceId: "workspace-general",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Source page",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("BacklinksPanel", () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it("renders backlinks and selects their source page", async () => {
    const backlink: Backlink = { page, excerpt: "A useful reference" };
    vi.mocked(api).mockResolvedValue({ backlinks: [backlink] });
    const onSelect = vi.fn();
    render(<BacklinksPanel pageId="target-page" revision={0} onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole("button", { name: /source page/i }));

    expect(api).toHaveBeenCalledWith("/api/pages/target-page/backlinks");
    expect(screen.getByText("A useful reference")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith("source-page");
  });

  it("shows an actionable failure state for a malformed response", async () => {
    vi.mocked(api).mockResolvedValue(null as never);
    render(<BacklinksPanel pageId="target-page" revision={0} onSelect={vi.fn()} />);

    expect(await screen.findByText("Backlinks could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("No pages link here yet.")).not.toBeInTheDocument();
  });
});
