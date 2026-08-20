import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManifest } from "./manifest.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "notion-manifest-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "export");
  mkdirSync(root);
  writeFileSync(join(root, "Page 11111111111111111111111111111111.html"), "<p>Page</p>");
  return { root, path: join(directory, "manifest.json") };
}

function open({ root, path }, overrides = {}) {
  return createManifest({
    path,
    root,
    baseURL: "https://notes.example.test",
    workspaceId: "workspace-1",
    rootParentId: null,
    ...overrides,
  });
}

describe("createManifest", () => {
  it("rejects a manifest from another workspace or root parent", () => {
    const files = fixture();
    open(files).flush();

    expect(() => open(files, { workspaceId: "workspace-2" })).toThrow(/different workspace/);
    expect(() => open(files, { rootParentId: "page-2" })).toThrow(/different --parent/);
  });

  it("adds the manifest path to malformed JSON errors", () => {
    const files = fixture();
    writeFileSync(files.path, "{not json");

    expect(() => open(files)).toThrow(new RegExp(`${files.path} is not readable as a manifest`));
  });

  it("rejects valid JSON that is not manifest state", () => {
    const files = fixture();
    writeFileSync(files.path, "null\n");

    expect(() => open(files)).toThrow(new RegExp(`${files.path} does not contain a valid manifest`));
  });
});
