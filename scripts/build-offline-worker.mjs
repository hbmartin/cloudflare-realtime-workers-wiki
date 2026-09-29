import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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

async function visit(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await visit(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

const paths = [
  ...staticFiles.map((name) => ({ path: join(clientRoot, name), url: name === "index.html" ? "/" : `/${name}` })),
  ...(await visit(join(clientRoot, "assets"))).map((path) => ({
    path,
    url: `/${relative(clientRoot, path).split(sep).join("/")}`,
  })),
];
paths.sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0));
const hash = createHash("sha256");
const urls = [];
for (const { path, url } of paths) {
  hash.update(url);
  hash.update(await readFile(path));
  urls.push(url);
}
const template = await readFile(join(projectRoot, "scripts/offline-worker-template.txt"), "utf8");
await writeFile(
  join(clientRoot, "sw.js"),
  template
    .replace("__CACHE_VERSION__", hash.digest("hex").slice(0, 16))
    .replace("__SHELL_ASSETS__", JSON.stringify(urls)),
);
