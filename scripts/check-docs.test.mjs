import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocs } from "./check-docs.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "noteflare-docs-"));
  roots.push(root);
  function write(file, text) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  write("README.md", "# App\n\n[Docs](docs/README.md)\n");
  write(
    "package.json",
    JSON.stringify({ scripts: { build: "vite build", deploy: "node scripts/deploy.mjs", check: "vitest" } }),
  );
  write("docs/README.md", "# Documentation\n\n[Config](CONFIGURATION.md)\n[Flags](FLAGS.md)\n");
  write(
    "docs/CONFIGURATION.md",
    "# Configuration\n\n| Name | Notes |\n| --- | --- |\n| `DB` | Database |\n| `OPENAI_API_KEY` | Secret |\n",
  );
  write("docs/FLAGS.md", "# Flags\n\n| Name | Default |\n| --- | --- |\n| `FEATURE_ENABLED` | false |\n");
  write("wrangler.jsonc", '{ // Test JSONC\n"vars":{"FEATURE_ENABLED":"false"},"d1_databases":[{"binding":"DB"}], }');
  write("src/worker/env.ts", "export interface AppBindings {\n  DB: D1Database;\n  OPENAI_API_KEY?: string;\n}\n");
  write(
    "worker-configuration.d.ts",
    "interface ProductionEnv {\n  DB: D1Database;\n}\ninterface GlobalProps {\n  NOT_A_BINDING: string;\n}\n",
  );
  write(".dev.vars.example", "OPENAI_API_KEY=fixture-sensitive-value\n");
  function files(directory = root, prefix = "") {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = `${prefix}${entry.name}`;
      return entry.isDirectory() ? files(join(directory, entry.name), `${file}/`) : [file];
    });
  }
  return { root, write, check: () => checkDocs(root, files()) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("documentation links and discovery", () => {
  it("accepts JSONC, exact table entries, and ignores generated helper types", () => {
    expect(fixture().check()).toEqual([]);
  });
  it("checks reference links, images, HTML links, GitHub slugs and duplicate headings", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      `# Documentation

[Config][config]
[Flags](FLAGS.md)
[Formatted heading](guide.md#hello-world)
[Duplicate](guide.md#hello-world-1)
[Named anchor](guide.md#explicit)
![Sample](assets/sample.png)
<a href="guide.md#hello-world"><img src="assets/sample.png" /></a>

[config]: CONFIGURATION.md
`,
    );
    f.write("docs/guide.md", '# **Hello** [world](https://example.test)\n\n# Hello world\n\n<a id="explicit"></a>\n');
    f.write("docs/assets/sample.png", "fixture");
    expect(f.check()).toEqual([]);
  });
  it("ignores external URLs and fenced, inline, and HTML code examples", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      `# Documentation

[Config](CONFIGURATION.md) [Flags](FLAGS.md)
[External](https://example.test/missing#fragment)
\`[Sample](missing.md)\`

\`\`\`md
[Sample](missing.md)
\`\`\`

<pre><code><a href="missing.md">sample</a></code></pre>

Inline <code>[Sample](missing.md)</code> and <code><img src="missing.png" /></code>.
`,
    );
    expect(f.check()).toEqual([]);
  });
  it("reports missing files, incorrect casing, malformed encoding, and missing fragments", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Documentation\n\n[Config](CONFIGURATION.md#absent) [Flags](FLAGS.md) [Missing](missing.md) [Case](configuration.md) [Encoding](%ZZ.md)\n",
    );
    const errors = f.check().join("\n");
    expect(errors).toContain("#absent");
    expect(errors).toContain("missing.md");
    expect(errors).toContain("configuration.md");
    expect(errors).toContain("%ZZ.md");
  });
  it("rejects plain and encoded traversal beyond the Git root", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Documentation\n\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) [Outside](../../outside.md) [Encoded](%2e%2e/%2e%2e/outside.md)\n",
    );
    expect(f.check().filter((error) => error.includes("escapes the Git root"))).toHaveLength(2);
  });
  it("checks other Markdown extensions and rejects filesystem URLs", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Documentation\n\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) [Guide](guide.markdown#hello) [Filesystem](file:///tmp/outside.md)\n",
    );
    f.write("docs/guide.markdown", "# Hello\n\n[Root](../README.md#absent)\n");
    expect(f.check()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("file:///tmp/outside.md"),
        expect.stringContaining("docs/guide.markdown: ../README.md#absent"),
      ]),
    );
  });
  it("rejects image symlinks and configuration sources outside the Git root", () => {
    const f = fixture();
    const outside = fixture();
    symlinkSync(join(outside.root, "README.md"), join(f.root, "docs", "external.png"));
    f.write(
      "docs/README.md",
      "# Documentation\n\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) ![Outside](external.png)\n",
    );
    rmSync(join(f.root, "src/worker/env.ts"));
    symlinkSync(join(outside.root, "src/worker/env.ts"), join(f.root, "src/worker/env.ts"));
    expect(f.check()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("symlink target escapes"),
        expect.stringContaining("configuration source escapes"),
      ]),
    );
  });
  it("accepts nested indexes but reports orphan pages", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Documentation\n\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) [Evidence](evidence/README.md)\n",
    );
    f.write("docs/evidence/README.md", "# Evidence\n\n[Record](record.md)\n");
    f.write("docs/evidence/record.md", "# Record\n");
    f.write("docs/orphan.md", "# Orphan\n");
    expect(f.check()).toEqual(["docs/orphan.md: unreachable from docs/README.md"]);
  });
  it("resolves repository-root, root-relative, and directory README links and fragments", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Documentation\n[Config](/docs/CONFIGURATION.md#configuration) [Flags](FLAGS.md) [Root](../#app) [Evidence](evidence/#evidence)\n",
    );
    f.write("docs/evidence/README.md", "# Evidence\n");
    expect(f.check()).toEqual([]);
    f.write("docs/evidence/README.md", "# Evidence\n[Missing](../#absent)\n");
    expect(f.check()).toContainEqual(expect.stringContaining("missing Markdown fragment #absent"));
  });
  it("excludes image alt text from heading anchors", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# ![Logo](assets/logo.png) Title\n[Self](#title) [Config](CONFIGURATION.md) [Flags](FLAGS.md)\n",
    );
    f.write("docs/assets/logo.png", "fixture");
    expect(f.check()).toEqual([]);
  });
  it.each(["code", "pre", "script", "style"])("reports unclosed raw HTML %s regions", (tag) => {
    const f = fixture();
    f.write(
      "docs/README.md",
      `# Documentation\n[Config](CONFIGURATION.md) [Flags](FLAGS.md)\n\nInline <${tag}>forgotten closing tag\n\n# Later heading\n[Missing](missing.md)\n`,
    );
    expect(f.check()).toContainEqual("docs/README.md: unclosed raw HTML code region");
  });
});

describe("configuration documentation coverage", () => {
  it("does not count prose or code examples as secret table entries", () => {
    const f = fixture();
    f.write(
      "docs/CONFIGURATION.md",
      "# Configuration\n\nUse `OPENAI_API_KEY`.\n\n| Name | Notes |\n| --- | --- |\n| `DB` | Database |\n| Mention `OPENAI_API_KEY` here | Prose inside a table is not an exact entry |\n",
    );
    const errors = f.check().join("\n");
    expect(errors).toContain("src/worker/env.ts: OPENAI_API_KEY");
    expect(errors).toContain(".dev.vars.example: OPENAI_API_KEY");
    expect(errors).not.toContain("fixture-sensitive-value");
  });
  it("requires documentation for single-character and mixed-case interface bindings", () => {
    const f = fixture();
    f.write(
      "src/worker/env.ts",
      "export interface AppBindings {\n  X?: string;\n  apiKey?: string;\n  _TOKEN?: string;\n}\n",
    );
    expect(f.check()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("src/worker/env.ts: X:"),
        expect.stringContaining("src/worker/env.ts: apiKey:"),
        expect.stringContaining("src/worker/env.ts: _TOKEN:"),
      ]),
    );
    f.write(
      "docs/CONFIGURATION.md",
      "# Configuration\n\n| Name | Notes |\n| --- | --- |\n| `X` | Secret |\n| `apiKey` | Secret |\n| `_TOKEN` | Secret |\n| `DB` | Binding |\n| `OPENAI_API_KEY` | Secret |\n",
    );
    expect(f.check()).toEqual([]);
  });
  it("checks required Wrangler secrets even without a generated declaration", () => {
    const f = fixture();
    f.write("wrangler.jsonc", '{"secrets":{"required":["AI_TOKEN_ENCRYPTION_KEY"]}}');
    expect(f.check()).toEqual([expect.stringContaining("wrangler.jsonc: AI_TOKEN_ENCRYPTION_KEY")]);
  });
  it("includes bindings and variables declared only in named environments", () => {
    const f = fixture();
    f.write(
      "wrangler.jsonc",
      JSON.stringify({
        env: { production: { vars: { PRODUCTION_ONLY: "true" }, r2_buckets: [{ binding: "ARCHIVE" }] } },
      }),
    );
    expect(f.check()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("wrangler.jsonc: ARCHIVE"),
        expect.stringContaining("wrangler.jsonc: PRODUCTION_ONLY"),
      ]),
    );
  });
  it("includes generated environment bindings and the separate local example", () => {
    const f = fixture();
    f.write("worker-configuration.d.ts", "interface __BaseEnv_CloudflareBindings {\n  GENERATED_ONLY?: string;\n}\n");
    f.write(".dev.vars.local.example", "LOCAL_ONLY=\n");
    expect(f.check()).toEqual(
      expect.arrayContaining([expect.stringContaining("GENERATED_ONLY"), expect.stringContaining("LOCAL_ONLY")]),
    );
  });
  it("reports malformed JSONC without evaluating it", () => {
    const f = fixture();
    f.write("wrangler.jsonc", "{not JavaScript or JSON}");
    expect(f.check().some((error) => error.startsWith("wrangler.jsonc:"))).toBe(true);
  });
  it("inspects direct members of inline aliases and ignores nested members and comments", () => {
    const f = fixture();
    f.write(
      "src/worker/env.ts",
      `export type AppBindings = {
      DB: D1Database;
      /* COMMENT_IS_NOT_A_BINDING: string; */
      OPENAI_API_KEY?: { nested: string; deeper: { field: number } };
      AFTER_NESTED?: string;
    }`,
    );
    f.write(
      "worker-configuration.d.ts",
      `declare namespace Cloudflare {
      interface GlobalProps { IGNORE_THIS: string; }
      interface Env { DB: { nested: { field: string } }; AFTER_GENERATED: string; }
    }
    declare namespace NodeJS { interface ProcessEnv { IGNORE_PROCESS_ENV: string; } }`,
    );
    expect(f.check()).toEqual([expect.stringContaining("AFTER_NESTED"), expect.stringContaining("AFTER_GENERATED")]);
  });
  it.each(["wrangler.jsonc", "src/worker/env.ts", "worker-configuration.d.ts", "package.json"])(
    "fails when the expected %s source is absent",
    (file) => {
      const f = fixture();
      rmSync(join(f.root, file));
      expect(f.check()).toContainEqual(`${file}: expected source is missing`);
    },
  );
  it.each([
    "export interface RenamedBindings { DB: D1Database; }",
    "export interface AppBindings {}",
    "export type AppBindings = OtherBindings;",
    "export type AppBindings = { [key: string]: string };",
  ])("rejects absent or unsupported AppBindings: %s", (source) => {
    const f = fixture();
    f.write("src/worker/env.ts", source);
    expect(f.check()).toContainEqual(expect.stringMatching(/src\/worker\/env.ts: (missing|AppBindings: unsupported)/));
  });
  it("fails when generated environment declarations disappear", () => {
    const f = fixture();
    f.write("worker-configuration.d.ts", "interface GlobalProps { value: string; }");
    expect(f.check()).toContainEqual(expect.stringContaining("missing generated binding"));
  });
  it.each(["src/worker/env.ts", "worker-configuration.d.ts"])("rejects an empty %s declaration source", (file) => {
    const f = fixture();
    f.write(file, "");
    expect(f.check()).toContainEqual(expect.stringContaining("declaration members"));
  });
  it("retains casing, traversal, and symlink checks for concrete repository references", () => {
    const f = fixture();
    const outside = fixture();
    f.write("scripts/example.mjs", "fixture");
    symlinkSync(join(outside.root, "README.md"), join(f.root, "scripts/outside.mjs"));
    f.write(
      "README.md",
      "# App\n[Docs](docs/README.md)\n`Scripts/example.mjs`\n`src/../../outside.mjs`\n`scripts/outside.mjs`\n",
    );
    expect(f.check()).toContainEqual(expect.stringContaining("src/../../outside.mjs: repository path escapes"));
    expect(f.check()).toContainEqual(
      expect.stringContaining("Scripts/example.mjs: repository path is missing or has incorrect casing"),
    );
    expect(f.check()).toContainEqual(expect.stringContaining("scripts/outside.mjs: repository path escapes"));
    f.write("README.md", "# App\n[Docs](docs/README.md)\n`scripts/Example.mjs`\n");
    expect(f.check()).toContainEqual(
      expect.stringContaining("scripts/Example.mjs: repository path is missing or has incorrect casing"),
    );
  });
  it.each([
    ["send_email", [{ name: "SEND_MAIL" }], "SEND_MAIL"],
    ["ai", { binding: "AI" }, "AI"],
    ["hyperdrive", [{ binding: "HYPERDRIVE", id: "0123456789abcdef0123456789abcdef" }], "HYPERDRIVE"],
    ["vectorize", [{ binding: "VECTORIZE", index_name: "test" }], "VECTORIZE"],
    ["images", { binding: "IMAGES" }, "IMAGES"],
  ])("uses Wrangler to find %s bindings in default and named environments", (kind, value, name) => {
    const f = fixture();
    f.write(
      "wrangler.jsonc",
      JSON.stringify({ [kind]: value, env: { staging: { [kind]: value, secrets: { required: ["STAGING_SECRET"] } } } }),
    );
    expect(f.check()).toContainEqual(expect.stringContaining(`wrangler.jsonc: ${name}:`));
    expect(f.check()).toContainEqual(expect.stringContaining("wrangler.jsonc: STAGING_SECRET:"));
  });
});

describe("current operator references", () => {
  it("accepts pnpm aliases and reporter values before commands and script names", () => {
    const f = fixture();
    f.write(
      "README.md",
      `# App
[Docs](docs/README.md)
\`pnpm i\` \`pnpm rm old-package\` \`pnpm un old-package\` \`pnpm uninstall old-package\`
\`pnpm up\` \`pnpm upgrade\` \`pnpm ls\`
\`pnpm --reporter silent run build\` \`pnpm run --reporter silent build\`
\`pnpm --reporter="silent" build\` \`pnpm --reporter 'silent' run build\`
\`pnpm --reporter silent --filter app run --silent missing-script\`
`,
    );
    expect(f.check()).toEqual(["README.md: missing package.json script missing-script"]);
  });
  it("recognizes built-ins and validates script names after pnpm options", () => {
    const f = fixture();
    f.write(
      "README.md",
      `# App
[Docs](docs/README.md)
\`pnpm create vite\` \`pnpm view wrangler version\` \`pnpm licenses list\`
\`pnpm --filter noteflare run --silent missing-script\`
\`pnpm -C . run build\` \`pnpm --filter=noteflare check\`
`,
    );
    expect(f.check()).toEqual(["README.md: missing package.json script missing-script"]);
  });
  it("accepts shorthand executables supplied by project dependencies", () => {
    const f = fixture();
    f.write("package.json", JSON.stringify({ scripts: {}, devDependencies: { "local-tool": "1.0.0" } }));
    f.write("node_modules/local-tool/package.json", JSON.stringify({ name: "local-tool", bin: { tool: "index.js" } }));
    f.write("README.md", "# App\n[Docs](docs/README.md)\n`pnpm tool --help`\n`pnpm run tool`\n");
    expect(f.check()).toEqual(["README.md: missing package.json script tool"]);
  });
  it("validates scripts, built-ins, and explicit paths in inline and executable examples", () => {
    const f = fixture();
    f.write(
      "README.md",
      `# App
[Docs](docs/README.md)
Use \`pnpm run build\`, \`pnpm check\`, \`pnpm exec wrangler whoami\`, and \`scripts/check.mjs\`.
\`\`\`sh
pnpm install --frozen-lockfile
pnpm run nonexistent
pnpm missing-shorthand
node scripts/missing.mjs
\`\`\`
`,
    );
    f.write("scripts/check.mjs", "fixture");
    expect(f.check()).toEqual([
      "README.md: missing package.json script missing-shorthand",
      "README.md: missing package.json script nonexistent",
      "README.md: scripts/missing.mjs: repository path is missing or has incorrect casing",
    ]);
  });
  it("rejects bare pnpm deploy even when a project script exists", () => {
    const f = fixture();
    f.write("README.md", "# App\n[Docs](docs/README.md)\n`pnpm deploy`\n`pnpm run deploy`\n");
    expect(f.check()).toEqual(["README.md: ambiguous pnpm deploy; use pnpm run deploy"]);
  });
  it("skips marked placeholders, non-executable fences, and historical command references", () => {
    const f = fixture();
    f.write(
      "README.md",
      `# App
[Docs](docs/README.md)
\`pnpm run <script>\` and \`src/{component}/example.ts\`.
<!-- check-docs:ignore-next -->
Use \`pnpm old-script\` or \`scripts/generated.mjs\` as schematic examples.
\`\`\`sh non-executable
pnpm illustrative
node scripts/illustrative.mjs
\`\`\`
\`\`\`text
pnpm not-a-command
scripts/not-a-file.mjs
\`\`\`
`,
    );
    f.write("docs/README.md", "# Docs\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) [Evidence](evidence/)\n");
    f.write("docs/evidence/README.md", "# Evidence\n`pnpm historical-command` and `scripts/deleted.mjs`\n");
    expect(f.check()).toEqual([]);
  });
  it("checks current commands in operator guides but keeps historical links checked", () => {
    const f = fixture();
    f.write(
      "docs/README.md",
      "# Docs\n[Config](CONFIGURATION.md) [Flags](FLAGS.md) [Upgrade](UPGRADING.md) [Evidence](evidence/)\n",
    );
    f.write("docs/UPGRADING.md", "# Upgrading\n`pnpm deploy:production`\n`.node-version`\n");
    f.write("docs/evidence/README.md", "# Evidence\n[Missing](missing.md)\n");
    expect(f.check()).toEqual([
      "docs/UPGRADING.md: .node-version: repository path is missing or has incorrect casing",
      "docs/UPGRADING.md: missing package.json script deploy:production",
      "docs/evidence/README.md: missing.md: target does not exist with this exact path",
    ]);
  });
});
