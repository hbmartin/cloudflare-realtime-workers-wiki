import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

let fixture;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});
it("links a registration ID into an install archive with the manifest, assets, and skills", async () => {
  fixture = await mkdtemp(join(tmpdir(), "noteflare-plugin-package-"));
  await cp(new URL("./link-plugin.mjs", import.meta.url), join(fixture, "scripts/link-plugin.mjs"), {
    recursive: true,
  });
  await cp(new URL("../plugins/noteflare", import.meta.url), join(fixture, "plugins/noteflare"), { recursive: true });
  const id = "plugin_asdk_app_test_registration";
  execFileSync(process.execPath, [join(fixture, "scripts/link-plugin.mjs"), id]);
  expect(JSON.parse(await readFile(join(fixture, "plugins/noteflare/.app.json"), "utf8"))).toEqual({
    apps: { noteflare: { id, required: true } },
  });
  const archive = join(fixture, "dist/noteflare-plugin.zip");
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  for (const path of [
    "plugin.json",
    ".app.json",
    "assets/logo.jpg",
    "assets/composer-icon.png",
    "skills/setup/SKILL.md",
    "skills/documents/SKILL.md",
  ])
    expect(entries).toContain(`noteflare/${path}`);
  // Invalid names cannot silently produce a package pointing to an invented connection.
  expect(() =>
    execFileSync(process.execPath, [join(fixture, "scripts/link-plugin.mjs"), "invalid"], { stdio: "pipe" }),
  ).toThrow(/Command failed/);
});
