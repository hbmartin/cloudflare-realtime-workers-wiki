import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const id = process.argv[2];
if (!id || !/^plugin_asdk_app_[A-Za-z0-9_]+$/.test(id))
  throw new Error("Usage: pnpm plugin:link plugin_asdk_app_<technical-id>");
const root = new URL("../plugins/noteflare/", import.meta.url);
await writeFile(
  new URL(".app.json", root),
  JSON.stringify({ apps: { noteflare: { id, required: true } } }, null, 2) + "\n",
);
const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
for (const path of [
  manifest.extensions["com.openai"].onboardingSkill,
  manifest.extensions["com.openai"].interface.composerIcon,
  manifest.extensions["com.openai"].interface.logo,
])
  await readFile(new URL(path, root));
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
await rm(new URL("noteflare-plugin.zip", output), { force: true });
execFileSync("zip", ["-q", "-r", fileURLToPath(new URL("noteflare-plugin.zip", output)), "noteflare"], {
  cwd: fileURLToPath(new URL("../plugins/", import.meta.url)),
});
process.stdout.write("Linked NoteFlare plugin and packaged dist/noteflare-plugin.zip.\n");
