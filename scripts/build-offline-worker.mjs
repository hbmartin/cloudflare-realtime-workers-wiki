import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientRoot = join(projectRoot, "dist/client");
const staticFiles = [
  "index.html",
  "theme-init.js",
  "manifest.webmanifest",
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "logo.jpg",
];

const manifest = JSON.parse(await readFile(join(clientRoot, ".vite/manifest.json"), "utf8"));
const assetFiles = new Set();
const visited = new Set();
function includeChunk(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk?.file) throw new Error(`Missing client bundle entry: ${key}`);
  assetFiles.add(chunk.file);
  for (const path of chunk.css ?? []) assetFiles.add(path);
  for (const path of chunk.assets ?? []) if (/\.woff2?$/.test(path)) assetFiles.add(path);
  for (const dependency of chunk.imports ?? []) includeChunk(dependency);
}
includeChunk("index.html");
includeChunk("src/client/SupportedApp.tsx");

const paths = [
  ...staticFiles.map((name) => ({ path: join(clientRoot, name), url: name === "index.html" ? "/" : `/${name}` })),
  ...[...assetFiles].map((name) => ({
    path: join(clientRoot, name),
    url: new URL(name, "https://noteflare.invalid/").pathname,
  })),
];
paths.sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0));
const hash = createHash("sha256");
const urls = [];
const template = await readFile(join(projectRoot, "scripts/offline-worker-template.txt"), "utf8");
hash.update(template);
hash.update(await readFile(join(projectRoot, "public/_headers")));
for (const { path, url } of paths) {
  hash.update(url);
  hash.update(await readFile(path));
  urls.push(url);
}
const workerPath = join(clientRoot, "sw.js");
await writeFile(
  workerPath,
  template
    .replace("__CACHE_VERSION__", () => hash.digest("hex").slice(0, 16))
    .replace("__SHELL_ASSETS__", () => JSON.stringify(urls)),
);
execFileSync(process.execPath, ["--check", workerPath]);
await unlink(join(clientRoot, ".vite/manifest.json"));
