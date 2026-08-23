import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManifest, fingerprintExport } from "./manifest.mjs";

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

function legacyAggregate(root, relativePaths) {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(join(root, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
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

  it("hashes file contents and rejects a same-size edit", () => {
    const files = fixture();
    open(files).flush();
    writeFileSync(join(files.root, "Page 11111111111111111111111111111111.html"), "<p>Fake</p>");

    expect(() => open(files)).toThrow(/different copy of this export/);
  });

  it("rejects a legacy raw-bytes version 2 manifest", () => {
    // The raw-bytes aggregate also shipped stamped version 2, but its NUL framing
    // cannot bind a manifest to one export unambiguously. Restarting is safer than
    // silently promoting whichever export happens to reproduce the old aggregate.
    const files = fixture();
    const relativePath = "Page 11111111111111111111111111111111.html";
    const legacyFingerprint = legacyAggregate(files.root, [relativePath]);
    writeFileSync(
      files.path,
      JSON.stringify({
        version: 2,
        importId: "a".repeat(32),
        startedAt: Date.now(),
        baseURL: "https://notes.example.test",
        workspaceId: "workspace-1",
        exportRoot: files.root,
        exportFingerprint: legacyFingerprint,
        rootParentId: null,
        nodes: {},
      }),
    );

    expect(() => open(files)).toThrow(/raw-byte fingerprints cannot be resumed safely/i);
    expect(JSON.parse(readFileSync(files.path, "utf8")).exportFingerprint).toBe(legacyFingerprint);
  });

  it("opens a version 2 manifest whose fingerprint hashed per-file digests", () => {
    const files = fixture();
    const relativePath = "Page 11111111111111111111111111111111.html";
    const digest = createHash("sha256")
      .update(readFileSync(join(files.root, relativePath)))
      .digest("hex");
    const digestFingerprint = createHash("sha256")
      .update(relativePath)
      .update("\0")
      .update(digest)
      .update("\0")
      .digest("hex");
    writeFileSync(
      files.path,
      JSON.stringify({
        version: 2,
        importId: "b".repeat(32),
        startedAt: Date.now(),
        baseURL: "https://notes.example.test",
        workspaceId: "workspace-1",
        exportRoot: files.root,
        exportFingerprint: digestFingerprint,
        rootParentId: null,
        nodes: {},
      }),
    );

    expect(open(files).state.importId).toBe("b".repeat(32));
  });

  it("rejects a legacy manifest whose raw aggregate collides with another export", () => {
    // One file containing "x\0<other path>\0y" and two files containing "x" and "y"
    // concatenate to the same path\0bytes\0 stream, so the raw-bytes aggregate cannot
    // tell these exports apart; the digest aggregate's fixed-width frames must.
    const directory = mkdtempSync(join(tmpdir(), "notion-manifest-"));
    temporaryDirectories.push(directory);
    const first = "Page 11111111111111111111111111111111.html";
    const second = "z.bin";
    const rootA = join(directory, "export-a");
    mkdirSync(rootA);
    writeFileSync(join(rootA, first), Buffer.from(`x\0${second}\0y`, "utf8"));
    const rootB = join(directory, "export-b");
    mkdirSync(rootB);
    writeFileSync(join(rootB, first), "x");
    writeFileSync(join(rootB, second), "y");
    const path = join(directory, "manifest.json");
    const collidingLegacyFingerprint = legacyAggregate(rootA, [first]);

    expect(legacyAggregate(rootB, [first, second])).toBe(collidingLegacyFingerprint);
    expect(fingerprintExport(rootB).fingerprint).not.toBe(fingerprintExport(rootA).fingerprint);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        importId: "c".repeat(32),
        startedAt: Date.now(),
        baseURL: "https://notes.example.test",
        workspaceId: "workspace-1",
        exportRoot: rootA,
        exportFingerprint: collidingLegacyFingerprint,
        rootParentId: null,
        nodes: {},
      }),
    );

    expect(() => open({ root: rootB, path })).toThrow(/raw-byte fingerprints cannot be resumed safely/i);
    expect(JSON.parse(readFileSync(path, "utf8")).exportFingerprint).toBe(collidingLegacyFingerprint);
  });

  it("uses a random import id and explicitly rejects version 1", () => {
    const first = fixture();
    const manifest = open(first);
    manifest.flush();
    const state = JSON.parse(readFileSync(first.path, "utf8"));
    expect(state.importId).toMatch(/^[0-9a-f]{32}$/);
    const second = fixture();
    open(second).flush();
    expect(JSON.parse(readFileSync(second.path, "utf8")).importId).not.toBe(state.importId);

    state.version = 1;
    writeFileSync(first.path, JSON.stringify(state));
    expect(() => open(first)).toThrow(/Version 1 did not hash file contents/);
  });
});
