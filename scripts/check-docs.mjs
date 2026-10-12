import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "htmlparser2";
import { marked } from "marked";
import GithubSlugger from "github-slugger";
import { parse } from "@babel/parser";
import { unstable_readConfig, unstable_convertConfigBindingsToStartWorkerBindings } from "wrangler";

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
      if (token.type === "image") return "";
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
  const examples = [];
  const slugger = new GithubSlugger();
  let ignoredHtml = 0;
  let ignoreNext = false;
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
    if (token.type === "html" && /<!--\s*check-docs:ignore-next\s*-->/.test(token.text)) {
      ignoreNext = true;
      return;
    }
    if (token.type === "space") return;
    if (ignoreNext) {
      // Skip this complete block, including its inline children.
      void marked.walkTokens([token], (child) => {
        child.skipReferences = true;
      });
      ignoreNext = false;
    }
    if (token.type === "html") html.write(token.text);
    if (ignoredHtml) return;
    if (
      !token.skipReferences &&
      (token.type === "codespan" ||
        (token.type === "code" &&
          /^(?:sh|bash|zsh|shell|console|powershell|ps1)(?:\s|$)/.test(token.lang ?? "") &&
          !/\bnon-executable\b/.test(token.lang)))
    )
      examples.push(token.text);
    if (token.type === "heading") anchors.add(slugger.slug(inlineText(token.tokens).trim()));
    if (token.type === "link" || token.type === "image") links.push(token.href);
    if (token.type === "table") {
      for (const row of token.rows) {
        const cell = row[0];
        const plain = inlineText(cell?.tokens);
        if (/^[A-Za-z_$][\w$]*$/.test(plain)) names.add(plain);
      }
    }
  });
  const unclosedHtml = ignoredHtml > 0;
  html.end();
  return { anchors, links, names, examples, unclosedHtml };
}

function declaredNames(source, generated = false) {
  const names = new Set();
  let found = false;
  const declarations = (nodes) => {
    for (let node of nodes) {
      if (node.type === "ExportNamedDeclaration") node = node.declaration;
      if (!node) continue;
      if (node.type === "TSModuleDeclaration" && node.body?.type === "TSModuleBlock") {
        if (node.id.name === "Cloudflare") declarations(node.body.body);
        continue;
      }
      const name = node.id?.name;
      const expected = generated
        ? name &&
          (name.startsWith("__BaseEnv_") ||
            name === "CloudflareBindings" ||
            (name.endsWith("Env") && name !== "ProcessEnv"))
        : name === "AppBindings";
      if (!expected) continue;
      found = true;
      const members =
        node.type === "TSInterfaceDeclaration"
          ? node.body.body
          : node.type === "TSTypeAliasDeclaration" && node.typeAnnotation.type === "TSTypeLiteral"
            ? node.typeAnnotation.members
            : null;
      if (!members)
        throw new Error(`${name}: unsupported binding declaration; use an interface or inline object type alias`);
      for (const member of members) {
        if (
          member.type !== "TSPropertySignature" ||
          member.computed ||
          !["Identifier", "StringLiteral"].includes(member.key.type)
        )
          throw new Error(`${name}: unsupported binding member`);
        names.add(member.key.name ?? member.key.value);
      }
    }
  };
  declarations(parse(source, { sourceType: "module", plugins: ["typescript"] }).program.body);
  if (!found || !names.size)
    throw new Error(`missing ${generated ? "generated binding" : "AppBindings"} declaration members`);
  return names;
}

const operatorGuides = new Set([
  "README.md",
  "CONTRIBUTING.md",
  ...[
    "DEPLOYMENT",
    "UPGRADING",
    "CONTINUOUS_DEPLOYMENT",
    "CONFIGURATION",
    "FLAGS",
    "OPERATIONS",
    "TROUBLESHOOTING",
    "LOGIN_DIAGNOSTICS",
    "OBSERVABILITY",
    "BACKUP_AND_RECOVERY",
  ].map((name) => `docs/${name}.md`),
]);
const pnpmBuiltins = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "config",
  "create",
  "completion",
  "dedupe",
  "dlx",
  "doctor",
  "env",
  "exec",
  "fetch",
  "help",
  "import",
  "init",
  "i",
  "install",
  "link",
  "licenses",
  "list",
  "ls",
  "login",
  "logout",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "peers",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "root",
  "server",
  "setup",
  "store",
  "unlink",
  "un",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "why",
  "view",
  "whoami",
]);

function concreteReferences(example, scripts, executables) {
  const errors = [];
  const executable = example
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((line) => line.replace(/(?:^|\s)#.*$/, ""))
    .join("\n");
  for (const match of executable.matchAll(/\bpnpm\s+([^\n;&|]+)/g)) {
    const words = match[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let index = 0;
    const skipOptions = () => {
      while (words[index]?.startsWith("-")) {
        const option = words[index++];
        if (["--filter", "--filter-prod", "--dir", "-C", "-F", "--reporter"].includes(option)) index++;
      }
    };
    skipOptions();
    const run = ["run", "run-script"].includes(words[index]);
    if (run) {
      index++;
      skipOptions();
    }
    const command = words[index]?.replace(/^["']|["']$/g, "");
    if (!command || /[<>{}$*…]/.test(command)) continue;
    if (!run && command === "deploy") errors.push("ambiguous pnpm deploy; use pnpm run deploy");
    else if (!Object.hasOwn(scripts, command) && (run || (!pnpmBuiltins.has(command) && !executables.has(command))))
      errors.push(`missing package.json script ${command}`);
  }
  const paths = [
    ...executable.matchAll(
      /(?:^|[\s'"(=])((?:\.?\/?(?:src|scripts|docs|tests|migrations|public|\.github|\.semgrep)\/|\.?\/)?[\w./{}$*<>…-]+)/g,
    ),
  ]
    .map((match) => match[1])
    .filter((path) =>
      /^(?:\.?\/?(?:src|scripts|docs|tests|migrations|public|\.github|\.semgrep)\/|(?:\.\/)?(?:wrangler\.(?:jsonc?|toml)|package\.json|pnpm-lock\.yaml|\.node-version|\.dev\.vars(?:\.[\w-]+)*\.example|[\w.-]+\.config\.[\w]+)$)/i.test(
        path,
      ),
    )
    .filter((path) => !/[<>{}$*…]/.test(path));
  return { errors, paths };
}

/** Pure inventory input lets fixtures check links without a Git repository. */
export function checkDocs(root, files) {
  root = realpathSync(root);
  const inventory = new Set(files.map(portable).filter((file) => existsSync(resolve(root, file))));
  const inventoryFiles = [...inventory];
  const documents = new Map();
  const errors = [];
  for (const file of inventory) {
    if (!isMarkdown(file)) continue;
    const path = resolve(root, file);
    if (!inside(root, path) || !inside(root, realpathSync(path))) {
      errors.push(`${file}: Markdown source escapes the Git root`);
      continue;
    }
    const document = markdown(readFileSync(path, "utf8"));
    documents.set(file, document);
    if (document.unclosedHtml) errors.push(`${file}: unclosed raw HTML code region`);
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
        const target = decoded
          ? decoded.startsWith("/")
            ? resolve(root, decoded.slice(1))
            : resolve(root, dirname(file), decoded)
          : resolve(root, file);
        if (!inside(root, target)) throw new Error("link escapes the Git root");
        let targetFile = portable(relative(root, target));
        const directory = inventoryFiles.some((candidate) => candidate.startsWith(targetFile ? `${targetFile}/` : ""));
        if (!inventory.has(targetFile) && !directory) throw new Error("target does not exist with this exact path");
        if (!inside(root, realpathSync(target))) throw new Error("symlink target escapes the Git root");
        if (statSync(target).isDirectory()) {
          const index = targetFile ? `${targetFile}/README.md` : "README.md";
          if (documents.has(index)) targetFile = index;
          else if (hash >= 0) throw new Error("directory has no README.md for fragment validation");
        }
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

  const tables = ["docs/CONFIGURATION.md", "docs/FLAGS.md"];
  const documented = new Set(tables.flatMap((file) => [...(documents.get(file)?.names ?? [])]));
  function requireNames(file, names) {
    for (const name of names) {
      if (!documented.has(name))
        errors.push(`${file}: ${name}: missing exact table entry in CONFIGURATION.md or FLAGS.md`);
    }
  }
  const read = (file, required = false) => {
    if (!inventory.has(file)) {
      if (required) errors.push(`${file}: expected source is missing`);
      return "";
    }
    const path = resolve(root, file);
    if (!inside(root, path) || !inside(root, realpathSync(path))) {
      errors.push(`${file}: configuration source escapes the Git root`);
      return "";
    }
    return readFileSync(path, "utf8");
  };
  if (read("wrangler.jsonc", true)) {
    try {
      const configPath = resolve(root, "wrangler.jsonc");
      const config = unstable_readConfig({ config: configPath, env: "" }, { hideWarnings: true });
      for (const environment of ["", ...config.definedEnvironments]) {
        const selected = environment
          ? unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true })
          : config;
        requireNames(
          "wrangler.jsonc",
          new Set([
            ...Object.keys(unstable_convertConfigBindingsToStartWorkerBindings(selected)),
            ...(selected.secrets?.required ?? []),
          ]),
        );
      }
    } catch (error) {
      errors.push(`wrangler.jsonc: ${error.message}`);
    }
  }
  for (const file of ["src/worker/env.ts", "worker-configuration.d.ts"]) {
    const source = read(file, true);
    if (!source && !inventory.has(file)) continue;
    try {
      requireNames(file, declaredNames(source, file.endsWith(".d.ts")));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  const packageSource = read("package.json", true);
  if (packageSource) {
    try {
      const packageJSON = JSON.parse(packageSource);
      const scripts = packageJSON.scripts;
      if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
        throw new Error("missing script declarations");
      const executables = new Set();
      const require = createRequire(resolve(root, "package.json"));
      for (const dependency of Object.keys({ ...packageJSON.dependencies, ...packageJSON.devDependencies })) {
        try {
          const info = JSON.parse(readFileSync(require.resolve(`${dependency}/package.json`), "utf8"));
          for (const name of typeof info.bin === "string"
            ? [dependency.split("/").at(-1)]
            : Object.keys(info.bin ?? {}))
            executables.add(name);
        } catch {
          // Unavailable package metadata cannot establish a shorthand executable.
        }
      }
      for (const [file, document] of documents) {
        if (!operatorGuides.has(file)) continue;
        for (const example of document.examples) {
          const references = concreteReferences(example, scripts, executables);
          errors.push(...references.errors.map((error) => `${file}: ${error}`));
          for (const path of references.paths) {
            const target = resolve(root, path.replace(/^\//, ""));
            const targetFile = portable(relative(root, target));
            if (!inside(root, target) || (existsSync(target) && !inside(root, realpathSync(target)))) {
              errors.push(`${file}: ${path}: repository path escapes the Git root`);
            } else if (
              !inventory.has(targetFile) &&
              !inventoryFiles.some((name) => name.startsWith(`${targetFile}/`))
            ) {
              errors.push(`${file}: ${path}: repository path is missing or has incorrect casing`);
            }
          }
        }
      }
    } catch (error) {
      errors.push(`package.json: ${error.message}`);
    }
  }
  for (const file of inventory) {
    if (!/^\.dev\.vars(?:\.[\w-]+)*\.example$/.test(file)) continue;
    requireNames(file, new Set([...read(file).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1])));
  }
  return [...new Set(errors)].sort();
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
