import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { notionIdOf, readExport, resolveLink, stripNotionId, walkExport } from "./export-tree.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "export");

describe("notion export naming", () => {
  it("recovers a title from every id suffix Notion writes", () => {
    expect(stripNotionId("Handbook abcdef0123456789abcdef0123456789")).toBe("Handbook");
    // Newer exports disambiguate a duplicate title on the folder with a partial id.
    expect(stripNotionId("Cool 3333-cccc")).toBe("Cool");
    expect(stripNotionId("Plain Title")).toBe("Plain Title");
  });

  it("reads the full id from a file name", () => {
    expect(notionIdOf("Handbook abcdef0123456789abcdef0123456789")).toBe("abcdef0123456789abcdef0123456789");
    expect(notionIdOf("Plain Title")).toBeNull();
  });
});

describe("reading an export", () => {
  it("skips archive noise and the sitemap", () => {
    const { files } = walkExport(root);
    expect(files.some((path) => path.includes("__MACOSX"))).toBe(false);

    const index = readExport(root);
    expect(index.pages.some((page) => page.path === "index.html")).toBe(false);
  });

  it("nests pages under the folder that belongs to their parent", () => {
    const index = readExport(root);
    const handbook = index.pages.find((page) => page.title === "Handbook");
    expect(handbook.parent).toBeNull();
    expect(handbook.children.map((child) => child.title).sort()).toEqual(["Onboarding", "Tasks"]);
  });

  it("pairs a partial-id folder with the file it disambiguates", () => {
    const index = readExport(root);
    const nested = index.pages.find((page) => page.title === "Nested");
    // The folder is "Cool 3333-cccc" and the file "Cool 3333...cccc.html"; nothing
    // matches by string equality, only by the partial id.
    expect(nested.parent?.title).toBe("Cool");
  });

  it("treats a page with a sibling CSV as a database and prefers the unfiltered export", () => {
    const index = readExport(root);
    const tasks = index.pages.find((page) => page.title === "Tasks");
    expect(tasks.kind).toBe("database");
    expect(tasks.csvPath).toMatch(/_all\.csv$/);
  });

  it("attaches an asset to the page whose folder holds it", () => {
    const index = readExport(root);
    const onboarding = index.pages.find((page) => page.title === "Onboarding");
    expect(onboarding.assets).toEqual([expect.stringContaining("diagram.png")]);
  });
});

describe("resolving links", () => {
  it("follows a percent-encoded relative link to another exported page", () => {
    const index = readExport(root);
    const target = resolveLink(
      "Handbook%20abcdef0123456789abcdef0123456789/Onboarding%201111111111111111111111111111aaaa.html",
      index,
    );
    expect(target?.title).toBe("Onboarding");
  });

  it("follows a link that climbs out of the referring folder", () => {
    const index = readExport(root);
    // Only the tail of the path is registered, so a `../` climb still resolves.
    expect(resolveLink("../Cool 3333333333333333333333333333cccc.html", index)?.title).toBe("Cool");
  });

  it("matches an absolute notion.so link by its trailing id", () => {
    const index = readExport(root);
    const target = resolveLink("https://www.notion.so/abcdef0123456789abcdef0123456789?pvs=21", index);
    expect(target?.title).toBe("Handbook");
  });

  it("returns nothing for a link that leaves the export", () => {
    const index = readExport(root);
    expect(resolveLink("https://example.test/elsewhere", index)).toBeNull();
  });

  it("resolves an asset reference to its path", () => {
    const index = readExport(root);
    const asset = resolveLink("Onboarding%201111111111111111111111111111aaaa/diagram.png", index);
    expect(asset).toEqual({ kind: "asset", path: expect.stringContaining("diagram.png") });
  });
});
