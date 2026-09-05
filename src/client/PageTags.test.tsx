// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tag } from "../shared/types";
import { PageTags } from "./PageTags";

const tag: Tag = {
  id: "tag-1",
  workspaceId: "workspace",
  name: "Research",
  color: "blue",
  pageCount: 1,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(cleanup);

describe("PageTags", () => {
  it("adds and removes existing tags", async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn().mockResolvedValue(true);
    render(
      <PageTags
        assigned={[tag]}
        available={[tag, { ...tag, id: "tag-2", name: "Launch", color: "green" }]}
        editable
        busy={false}
        onAdd={onAdd}
        onRemove={onRemove}
        onCreate={vi.fn().mockResolvedValue(true)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Research tag" }));
    expect(onRemove).toHaveBeenCalledWith(tag);
    fireEvent.change(screen.getByLabelText("Add tag"), { target: { value: "tag-2" } });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "tag-2" }));
  });

  it("keeps the create form open when creation fails", async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    render(
      <PageTags
        assigned={[]}
        available={[]}
        editable
        busy={false}
        onAdd={vi.fn().mockResolvedValue(true)}
        onRemove={vi.fn().mockResolvedValue(true)}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ New tag" }));
    fireEvent.change(screen.getByLabelText("Tag name"), { target: { value: "Design" } });
    fireEvent.change(screen.getByLabelText("Tag color"), { target: { value: "purple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith("Design", "purple");
    expect(await screen.findByLabelText("Tag name")).toBeInTheDocument();
  });
});
