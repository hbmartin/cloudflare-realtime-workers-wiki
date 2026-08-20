import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scripts = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(scripts, "notion-import.mjs");
const fixture = join(scripts, "notion-import", "__fixtures__", "export");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("notion importer CLI", () => {
  it("rejects an invalid linger duration", () => {
    const result = spawnSync(process.execPath, [entrypoint, "inspect", fixture, "--linger-ms", "not-a-number"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--linger-ms must be an integer between 0 and 60000");
  });

  it("does not coerce an empty linger duration to zero", () => {
    const result = spawnSync(process.execPath, [entrypoint, "inspect", fixture, "--linger-ms="], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--linger-ms must be an integer between 0 and 60000");
  });

  it("rejects a missing verification manifest before connecting", () => {
    const directory = mkdtempSync(join(tmpdir(), "notion-cli-"));
    temporaryDirectories.push(directory);
    const manifest = join(directory, "missing.json");
    const result = spawnSync(
      process.execPath,
      [entrypoint, "verify", fixture, "--email", "owner@example.test", "--manifest", manifest],
      {
        encoding: "utf8",
        env: { ...process.env, NOTES_IMPORT_PASSWORD: "password" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No manifest at ${manifest}`);
    expect(result.stderr).not.toContain("fetch failed");
  });
});
