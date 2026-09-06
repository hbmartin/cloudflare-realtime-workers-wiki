// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, SearchResponse, Space, Tag } from "../shared/types";
import { api } from "./api";
import { SearchView } from "./SearchView";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const space: Space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "Product",
  slug: "product",
  description: "",
  icon: "🚀",
  position: "a0",
  visibility: "workspace",
  effectiveRole: "editor",
  createdAt: 1,
  updatedAt: 1,
};

const tag: Tag = {
  id: "tag-1",
  workspaceId: "workspace-1",
  name: "Launch",
  color: "purple",
  pageCount: 1,
  createdAt: 1,
  updatedAt: 1,
};

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: space.id,
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Mars roadmap",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
};

function response(results = [page], hasMore = false): SearchResponse {
  return {
    results: results.map((result) => ({
      page: result,
      space: { id: space.id, name: space.name, icon: space.icon },
      snippet: { source: "body", text: "Mars launch checklist" },
    })),
    limit: 20,
    offset: 0,
    hasMore,
  };
}

beforeEach(() => {
  history.replaceState(null, "", "/?view=search&q=Mars");
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/members") return { members: [{ id: "user-1", name: "Ada", email: "ada@example.test" }] };
    if (path.startsWith("/api/search?")) return response();
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SearchView", () => {
  it("loads source-aware results and persists removable filters in the URL", async () => {
    render(<SearchView spaces={[space]} tags={[tag]} onSelect={vi.fn()} />);

    expect(screen.getByText("Searching…").parentElement).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByText("Mars roadmap")).toBeInTheDocument();
    expect(screen.getByText(/Product \/ Page/)).toBeInTheDocument();
    expect(screen.getByText("Page", { selector: ".search-results span b" }).parentElement).toHaveTextContent(
      "Page · Mars launch checklist",
    );

    fireEvent.click(screen.getByText("Filters"));
    fireEvent.change(screen.getByLabelText("Space"), { target: { value: space.id } });
    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: tag.id } });
    fireEvent.change(screen.getByLabelText("Page type"), { target: { value: "document" } });

    expect(await screen.findByRole("button", { name: "Remove Space: Product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Tag: Launch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Documents" })).toBeInTheDocument();
    await waitFor(() => {
      expect(location.search).toContain("space=space-1");
      expect(location.search).toContain("tag=tag-1");
      expect(location.search).toContain("kind=document");
    });
  });

  it("appends the next result page", async () => {
    const second = { ...page, id: "page-2", title: "Mars launch plan" };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/members") return { members: [] };
      if (path.includes("offset=0")) return response([page], true);
      if (path.includes("offset=1")) return response([second], false);
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SearchView spaces={[space]} tags={[tag]} onSelect={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Mars launch plan")).toBeInTheDocument();
    expect(screen.getByText("Mars roadmap")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
