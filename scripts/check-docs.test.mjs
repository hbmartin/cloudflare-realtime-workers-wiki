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
});
