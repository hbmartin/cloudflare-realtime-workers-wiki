/**
 * Reads an unpacked Notion HTML export into a page tree.
 *
 * Notion's naming is not quite a convention. Page files still carry a 32-hex id
 * suffix, but folders often do not any more, and when two pages share a title Notion
 * disambiguates the *folder* with a partial `{first4}-{last4}` of the file's id. So a
 * folder is paired to its page by three rules in order of confidence rather than by
 * string equality, and the ambiguous rule runs last so a folder carrying a partial id
 * claims its specific file before a plain folder takes whatever is left.
 *
 * Links are resolved by registering every suffix of every path, which is what makes a
 * relative href work regardless of how many `../` segments it climbs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const FULL_ID = /([0-9a-f]{32})$/i;
const byName = (left, right) => left.localeCompare(right);
const PARTIAL_ID = / ([0-9a-f]{4})-([0-9a-f]{4})$/i;

/** Strips Notion's id suffixes from a file or folder name to recover the title. */
export function stripNotionId(name) {
  return name
    .replace(/[ -]?[0-9a-f]{32}$/i, "")
    .replace(/ [0-9a-f]{4}-[0-9a-f]{4}$/i, "")
    .trim();
}

export function notionIdOf(name) {
  return FULL_ID.exec(name)?.[1]?.toLowerCase() ?? null;
}

function partialIdOf(name) {
  const match = PARTIAL_ID.exec(name);
  return match ? { prefix: match[1].toLowerCase(), suffix: match[2].toLowerCase() } : null;
}

/** Every file in the export, as paths relative to the root, using `/` separators. */
export function walkExport(root) {
  const found = [];
  const directories = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // `__MACOSX` and dotfiles are archive noise, never exported content.
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      const relativePath = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        directories.push(relativePath);
        stack.push(full);
      } else {
        found.push(relativePath);
      }
    }
  }
  return { files: found.sort(byName), directories: directories.sort(byName) };
}

function stem(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function extensionOf(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function parentDirectory(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Pairs each directory with the page whose children it holds.
 *
 * Directories carrying a partial id are matched first: they name one specific file, so
 * letting a plain same-titled folder match first would mis-assign both.
 */
function pairDirectories(directories, pagesByPath) {
  const owners = new Map();
  const claimed = new Set();
  const ordered = [...directories].sort((left, right) => {
    const leftPartial = partialIdOf(basename(left)) ? 0 : 1;
    const rightPartial = partialIdOf(basename(right)) ? 0 : 1;
    return leftPartial - rightPartial || left.localeCompare(right);
  });

  for (const directory of ordered) {
    const exact = pagesByPath.get(`${directory}.html`);
    if (exact && !claimed.has(exact.path)) {
      owners.set(directory, exact);
      claimed.add(exact.path);
      continue;
    }
    const siblings = [...pagesByPath.values()].filter(
      (page) => parentDirectory(page.path) === parentDirectory(directory),
    );
    const name = basename(directory);
    const partial = partialIdOf(name);
    const candidate = partial
      ? siblings.find(
          (page) =>
            !claimed.has(page.path) &&
            page.notionId?.startsWith(partial.prefix) &&
            page.notionId?.endsWith(partial.suffix),
        )
      : siblings.find((page) => !claimed.has(page.path) && page.title === stripNotionId(name));
    if (candidate) {
      owners.set(directory, candidate);
      claimed.add(candidate.path);
    }
  }
  return owners;
}

/**
 * Registers every suffix of a path so a relative href resolves without having to
 * normalize `../` climbs against the referring file.
 */
function registerSuffixes(index, path, value) {
  const segments = path.split("/");
  while (segments.length) {
    const key = segments.join("/");
    if (!index.has(key)) index.set(key, value);
    segments.shift();
  }
}

export function readExport(root) {
  const { files, directories } = walkExport(root);
  const issues = [];

  const pagesByPath = new Map();
  const assetsByPath = new Map();
  const csvByStem = new Map();

  for (const path of files) {
    const extension = extensionOf(path);
    if (extension === ".html") {
      // A root-level index.html is the export's sitemap, not a page.
      if (basename(path).toLowerCase() === "index.html" && !path.includes("/")) continue;
      const name = stem(path);
      pagesByPath.set(path, {
        kind: "document",
        path,
        title: stripNotionId(name) || "Untitled",
        notionId: notionIdOf(name),
        parent: null,
        children: [],
        assets: [],
        csvPath: null,
      });
    } else if (extension === ".csv") {
      const name = stem(path);
      // Notion writes both a view CSV and an `_all` CSV; the latter ignores view filters.
      const key = name.endsWith("_all") ? name.slice(0, -4) : name;
      const existing = csvByStem.get(key);
      if (!existing || name.endsWith("_all")) csvByStem.set(key, path);
    } else if (extension === ".zip") {
      issues.push({ code: "nested_archive", detail: path });
    } else {
      assetsByPath.set(path, { kind: "asset", path });
    }
  }

  const owners = pairDirectories(directories, pagesByPath);

  for (const page of pagesByPath.values()) {
    // Climb until a directory with a known owner is found, so a page nested under a
    // folder that has no page of its own still attaches to the right ancestor.
    let directory = parentDirectory(page.path);
    while (directory) {
      const owner = owners.get(directory);
      if (owner && owner !== page) {
        page.parent = owner;
        owner.children.push(page);
        break;
      }
      directory = parentDirectory(directory);
    }
  }

  for (const asset of assetsByPath.values()) {
    let directory = parentDirectory(asset.path);
    while (directory) {
      const owner = owners.get(directory);
      if (owner) {
        owner.assets.push(asset.path);
        break;
      }
      directory = parentDirectory(directory);
    }
  }

  // A page with a sibling CSV of the same stem is a database view, not a document.
  for (const page of pagesByPath.values()) {
    const csv = csvByStem.get(stem(page.path));
    if (csv) {
      page.kind = "database";
      page.csvPath = csv;
    }
  }

  const byPath = new Map();
  for (const page of pagesByPath.values()) registerSuffixes(byPath, page.path, page);
  const assetIndex = new Map();
  for (const path of assetsByPath.keys()) registerSuffixes(assetIndex, path, path);

  const byNotionId = new Map();
  for (const page of pagesByPath.values()) {
    if (page.notionId) byNotionId.set(page.notionId, page);
  }

  const roots = [...pagesByPath.values()].filter((page) => !page.parent);
  return { root, pages: [...pagesByPath.values()], roots, byPath, byNotionId, assetIndex, issues };
}

/**
 * Resolves one `href` or `src` to a page or an asset.
 *
 * An absolute notion.so link is matched by its trailing 32-hex, which is how Notion
 * writes a link to a page that also exists in the export.
 */
export function resolveLink(href, index) {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Already decoded, or malformed escaping; match on the raw value.
  }
  const withoutFragment = decoded.split("#")[0].split("?")[0];
  if (/^https?:/i.test(withoutFragment)) {
    const id = notionIdOf(withoutFragment.replace(/\/+$/, "").replaceAll("-", ""));
    return id ? (index.byNotionId.get(id) ?? null) : null;
  }
  const segments = withoutFragment.split("/").filter((segment) => segment && segment !== ".");
  while (segments.length) {
    const key = segments.join("/");
    const page = index.byPath.get(key);
    if (page) return page;
    const asset = index.assetIndex.get(key);
    if (asset) return { kind: "asset", path: asset };
    segments.shift();
  }
  return null;
}

/** Reads a page's HTML body. Separated so tests can build a tree without any files. */
export function readPageHtml(root, page) {
  return readFileSync(join(root, page.path), "utf8");
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
