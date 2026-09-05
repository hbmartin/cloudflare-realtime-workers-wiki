// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Space } from "../shared/types";
import { TemplateLibrary } from "./TemplateLibrary";

const space: Space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "Product",
  slug: "product",
  description: "",
  icon: null,
  position: "a0",
  visibility: "private",
  effectiveRole: "editor",
  createdAt: 1,
  updatedAt: 1,
};

const template: Page = {
  id: "template-1",
  workspaceId: space.workspaceId,
  spaceId: space.id,
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Project brief",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: true,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(cleanup);

describe("TemplateLibrary", () => {
  it("describes the active scope and exposes edit and instantiate actions", () => {
    const edit = vi.fn();
    const use = vi.fn();
    render(<TemplateLibrary templates={[template]} space={space} editable busyId={null} onEdit={edit} onUse={use} />);

    expect(screen.getByText("Templates in Product inherit this space’s access.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));
    expect(edit).toHaveBeenCalledWith(template);
    expect(use).toHaveBeenCalledWith(template);
  });

  it("does not offer instantiation to a viewer", () => {
    render(
      <TemplateLibrary
        templates={[template]}
        space={{ ...space, effectiveRole: "viewer" }}
        editable={false}
        busyId={null}
        onEdit={vi.fn()}
        onUse={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Use template" })).not.toBeInTheDocument();
  });
});
