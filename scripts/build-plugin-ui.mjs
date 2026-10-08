import { build, context } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = {
  absWorkingDir: root,
  entryPoints: ["src/plugin-ui/main.tsx"],
  bundle: true,
  write: false,
  outdir: "plugin-ui",
  format: "esm",
  jsx: "automatic",
  target: ["chrome116", "firefox124", "safari17.4"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
};
async function writeBundle(result) {
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const style = result.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!script || !style) throw new Error("The plugin UI script or stylesheet is missing.");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="noteflare-plugin-ui" content="0.1.0"><title>NoteFlare</title><style>${style.text}</style></head><body><div id="root"></div><script type="module">${script.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  await mkdir(new URL("../public/plugin-ui/", import.meta.url), { recursive: true });
  await writeFile(new URL("../public/plugin-ui/noteflare.html", import.meta.url), html);
  process.stdout.write(`NoteFlare plugin UI: ${Buffer.byteLength(html)} bytes, scripts and styles bundled.\n`);
}
if (process.argv.includes("--watch")) {
  const watcher = await context({
    ...options,
    plugins: [
      {
        name: "noteflare-inline-ui",
        setup(builder) {
          builder.onEnd(async (result) => {
            if (!result.errors.length) await writeBundle(result);
          });
        },
      },
    ],
  });
  await watcher.watch();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void watcher.dispose().then(() => process.exit(0));
    });
} else await writeBundle(await build(options));
