import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "htmlparser2";
import { marked } from "marked";
import GithubSlugger from "github-slugger";
import { parse, printParseErrorCode } from "jsonc-parser";

const isMarkdown = (file) => /\.(?:md|markdown)$/i.test(file);
const portable = (path) => path.split(sep).join("/");
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

function textContent(value) {
  let text = "";
  new Parser({ ontext: (part) => (text += part) }, { decodeEntities: true }).end(value);
  return text;
}

function inlineText(tokens = []) {
  return tokens
    .map((token) => {
      if (token.tokens) return inlineText(token.tokens);
      return token.type === "codespan" ? token.text : textContent(token.text ?? token.raw ?? "");
    })
    .join("");
}

function markdown(source) {
  const tokens = marked.lexer(source);
  const anchors = new Set();
  const links = [];
  const names = new Set();
  const slugger = new GithubSlugger();
  let ignoredHtml = 0;
  const html = new Parser(
    {
      onopentag(name, attrs) {
        if (["pre", "code", "script", "style"].includes(name)) ignoredHtml++;
        if (ignoredHtml) return;
        if (attrs.id) anchors.add(attrs.id);
        if (name === "a" && attrs.name) anchors.add(attrs.name);
        if (attrs.href) links.push(attrs.href);
        if (attrs.src) links.push(attrs.src);
      },
      onclosetag(name) {
        if (["pre", "code", "script", "style"].includes(name)) ignoredHtml = Math.max(0, ignoredHtml - 1);
      },
    },
    { decodeEntities: true },
  );
  void marked.walkTokens(tokens, (token) => {
    if (token.type === "html") html.write(token.text);
    if (ignoredHtml) return;
    if (token.type === "heading") anchors.add(slugger.slug(inlineText(token.tokens)));
    if (token.type === "link" || token.type === "image") links.push(token.href);
    if (token.type === "table") {
      for (const row of token.rows) {
        const cell = row[0];
        const plain = inlineText(cell?.tokens);
        if (/^[A-Za-z_$][\w$]*$/.test(plain)) names.add(plain);
      }
    }
  });
  html.end();
  return { anchors, links, names };
}

function declaredNames(source, pattern) {
  const names = new Set();
  for (const match of source.matchAll(pattern)) {
    for (const property of match[1].matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)) {
      names.add(property[1]);
    }
  }
  return names;
}

function configuredNames(config) {
  const names = new Set([...Object.keys(config.vars ?? {}), ...(config.secrets?.required ?? [])]);
  for (const key of [
    "d1_databases",
    "r2_buckets",
    "workflows",
    "analytics_engine_datasets",
    "kv_namespaces",
    "services",
    "send_email",
  ]) {
    for (const entry of config[key] ?? []) if (entry.binding) names.add(entry.binding);
  }
  for (const entry of config.durable_objects?.bindings ?? []) names.add(entry.name);
  for (const entry of config.ratelimits ?? []) names.add(entry.name);
  for (const entry of config.queues?.producers ?? []) names.add(entry.binding);
  for (const key of ["assets", "browser", "version_metadata"]) {
    if (config[key]?.binding) names.add(config[key].binding);
  }
  for (const environment of Object.values(config.env ?? {})) {
    for (const name of configuredNames(environment)) names.add(name);
  }
  return names;
}

/** Pure inventory input lets fixtures check links without a Git repository. */
export function checkDocs(root, files) {
  root = realpathSync(root);
  const inventory = new Set(files.map(portable).filter((file) => existsSync(resolve(root, file))));
  const documents = new Map();
  const errors = [];
  for (const file of inventory) {
    if (!isMarkdown(file)) continue;
    const path = resolve(root, file);
    if (!inside(root, path) || !inside(root, realpathSync(path))) {
      errors.push(`${file}: Markdown source escapes the Git root`);
      continue;
    }
    documents.set(file, markdown(readFileSync(path, "utf8")));
  }
  const graph = new Map();
  for (const [file, document] of documents) {
    const destinations = new Set();
    graph.set(file, destinations);
    for (const href of document.links) {
      if (/^file:/i.test(href)) {
        errors.push(`${file}: ${href}: filesystem URLs are outside repository navigation`);
        continue;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) continue;
      try {
        const hash = href.indexOf("#");
        const pathPart = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
        const decoded = decodeURIComponent(pathPart);
        const target = decoded ? resolve(root, dirname(file), decoded) : resolve(root, file);
        if (!inside(root, target)) throw new Error("link escapes the Git root");
        const targetFile = portable(relative(root, target));
        const directory = [...inventory].some((candidate) => candidate.startsWith(`${targetFile}/`));
        if (!inventory.has(targetFile) && !directory) throw new Error("target does not exist with this exact path");
        if (!inside(root, realpathSync(target))) throw new Error("symlink target escapes the Git root");
        if (statSync(target).isDirectory() && hash >= 0)
          throw new Error("directory links cannot have a Markdown fragment");
        if (documents.has(targetFile)) {
          destinations.add(targetFile);
          const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
          if (fragment && !documents.get(targetFile).anchors.has(fragment))
            throw new Error(`missing Markdown fragment #${fragment}`);
        }
      } catch (error) {
        errors.push(`${file}: ${href}: ${error.message}`);
      }
    }
  }
  const reached = new Set();
  const pending = ["docs/README.md"];
  if (!documents.has(pending[0])) errors.push("docs/README.md: documentation index is missing");
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  for (const file of documents.keys()) {
    if (file.startsWith("docs/") && !reached.has(file)) errors.push(`${file}: unreachable from docs/README.md`);
  }

  const references = ["docs/CONFIGURATION.md", "docs/FLAGS.md"];
  const documented = new Set(references.flatMap((file) => [...(documents.get(file)?.names ?? [])]));
  function requireNames(file, names) {
    for (const name of names) {
      if (!documented.has(name))
        errors.push(`${file}: ${name}: missing exact table entry in CONFIGURATION.md or FLAGS.md`);
    }
  }
  const read = (file) => {
    if (!inventory.has(file)) return "";
    const path = resolve(root, file);
    if (!inside(root, path) || !inside(root, realpathSync(path))) {
      errors.push(`${file}: configuration source escapes the Git root`);
      return "";
    }
    return readFileSync(path, "utf8");
  };
  if (inventory.has("wrangler.jsonc")) {
    const parseErrors = [];
    const config = parse(read("wrangler.jsonc"), parseErrors, { allowTrailingComma: true });
    for (const error of parseErrors)
      errors.push(`wrangler.jsonc: ${printParseErrorCode(error.error)} at offset ${error.offset}`);
    if (!parseErrors.length && config) requireNames("wrangler.jsonc", configuredNames(config));
  }
  requireNames(
    "src/worker/env.ts",
    declaredNames(read("src/worker/env.ts"), /interface\s+AppBindings\b[^{]*\{([\s\S]*?)^\}/gm),
  );
  requireNames(
    "worker-configuration.d.ts",
    declaredNames(
      read("worker-configuration.d.ts"),
      /interface\s+(?:__BaseEnv_\w+|CloudflareBindings|\w*Env)\b[^{]*\{([\s\S]*?)^\s*\}/gm,
    ),
  );
  for (const file of inventory) {
    if (!/^\.dev\.vars(?:\.[\w-]+)*\.example$/.test(file)) continue;
    requireNames(file, new Set([...read(file).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1])));
  }
  return errors.sort();
}

function main() {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (git.status !== 0) throw new Error("Run check:docs inside the Git repository");
  const root = git.stdout.trim();
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error("Could not inventory repository files");
  const errors = checkDocs(root, listed.stdout.split("\0").filter(Boolean));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Documentation links, discovery, and configuration coverage pass.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
