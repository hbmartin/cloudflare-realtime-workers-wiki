import { describe, expect, it } from "vitest";
import {
  evaluateMetadataIntegrity,
  integrityMetadataSql,
  type IntegrityMetadata,
  type IntegrityPage,
} from "./integrity";

const page = (id: string, overrides: Partial<IntegrityPage> = {}): IntegrityPage => ({
  id,
  workspace_id: "workspace",
  space_id: "space",
  parent_id: null,
  kind: "document",
  revision: 1,
  content_epoch: 1,
  indexed_seq: 0,
  updated_at: 1,
  archived_at: null,
  is_template: 0,
  import_job_id: null,
  ...overrides,
});
const metadata = (pages: IntegrityPage[]): IntegrityMetadata => ({
  workspaces: [{ id: "workspace" }],
  pages,
  spaces: [{ id: "space", workspace_id: "workspace" }],
  rowPages: [],
  sources: [],
  artifacts: [],
  complete: true,
});

describe("stored metadata integrity", () => {
  it("recognizes ordinary, staged, archived, template and attached row-detail roots", () => {
    const data = metadata([
      page("root"),
      page("staged", { import_job_id: "job" }),
      page("archived", { archived_at: 1 }),
      page("template", { is_template: 1 }),
      page("table", { kind: "table" }),
      page("detail"),
      page("artifact"),
    ]);
    data.rowPages.push({
      page_id: "detail",
      row_id: "row",
      table_page_id: "table",
      workspace_id: "workspace",
      space_id: "space",
    });
    data.sources.push(
      { page_id: "detail", source_role: "table_row_detail" },
      { page_id: "artifact", source_role: "generated_folder" },
    );
    expect(evaluateMetadataIntegrity(data)).toMatchObject({
      ok: true,
      complete: true,
      classifications: { root: 2, staged: 1, archived: 1, template: 1, row_detail: 1, import_artifact: 1 },
    });
  });

  it.each([
    ["invalid_space", [page("bad", { space_id: "missing" })]],
    ["invalid_revision", [page("bad", { revision: 0 })]],
    ["missing_ancestor", [page("bad", { parent_id: "missing" })]],
    ["ancestor_cycle", [page("a", { parent_id: "b" }), page("b", { parent_id: "a" })]],
    ["active_below_archived", [page("parent", { archived_at: 1 }), page("child", { parent_id: "parent" })]],
    ["published_below_staged", [page("parent", { import_job_id: "job" }), page("child", { parent_id: "parent" })]],
  ])("reports %s", (code, pages) => {
    const result = evaluateMetadataIntegrity(metadata(pages as IntegrityPage[]));
    expect(result.ok).toBe(false);
    expect(result.failures.some((finding) => finding.code === code)).toBe(true);
  });

  it("reports corrupt row ownership and cross-workspace artifact links", () => {
    const data = metadata([page("table", { kind: "table" }), page("detail")]);
    data.rowPages.push({
      page_id: "detail",
      row_id: "row",
      table_page_id: "table",
      workspace_id: "elsewhere",
      space_id: "space",
    });
    data.artifacts.push({ id: "attachment", page_id: "detail", workspace_id: "elsewhere", r2_key: "key", size: 1 });
    expect(evaluateMetadataIntegrity(data).failures.map((finding) => finding.code)).toEqual([
      "invalid_row_detail",
      "invalid_artifact",
    ]);
  });

  it("cannot pass a partial metadata scan or an unbounded ancestor chain", () => {
    const data = metadata(
      Array.from({ length: 67 }, (_, index) =>
        page(String(index), { parent_id: index < 66 ? String(index + 1) : null }),
      ),
    );
    expect(evaluateMetadataIntegrity(data, [data.pages[0]!])).toMatchObject({
      ok: false,
      complete: false,
      incomplete: [{ code: "ancestor_depth_limit", pageId: "0" }],
    });
    data.complete = false;
    expect(evaluateMetadataIntegrity(data).ok).toBe(false);
  });

  it("bounds every collection query and rejects untrusted limits", () => {
    expect(Object.values(integrityMetadataSql(100)).every((query) => query.endsWith("LIMIT 101"))).toBe(true);
    expect(() => integrityMetadataSql(0)).toThrow(/invalid|Document|Tab/i);
    expect(() => integrityMetadataSql(100_001)).toThrow(/invalid|Document|Tab/i);
  });
});
