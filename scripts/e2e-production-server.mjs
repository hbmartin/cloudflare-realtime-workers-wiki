import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const statePath = resolve(root, ".wrangler/e2e-production");
const environment = "notes-checks-e2e";
const varsPath = resolve(root, `.dev.vars.${environment}`);
const vars = [
  "BETTER_AUTH_SECRET=e2e-secret-with-at-least-32-characters",
  "BETTER_AUTH_URL=http://localhost:4173",
  "BOOTSTRAP_TOKEN=e2e-bootstrap-token",
  "",
].join("\n");
const priorVars = existsSync(varsPath) ? readFileSync(varsPath, "utf8") : null;
if (!statePath.startsWith(`${root}/.wrangler/`)) throw new Error(`Unexpected state path: ${statePath}`);
if (priorVars !== null && priorVars !== vars) {
  throw new Error(`Refusing to replace an existing ${varsPath}.`);
}
const restoreVars = () => {
  if (priorVars === null) rmSync(varsPath, { force: true });
  else writeFileSync(varsPath, priorVars, { encoding: "utf8", mode: 0o600 });
};
writeFileSync(varsPath, vars, { encoding: "utf8", mode: 0o600 });
if (process.env.NOTES_E2E_RESET === "1") rmSync(statePath, { recursive: true, force: true });

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildEnv = {
  ...process.env,
  CLOUDFLARE_ENV: environment,
  NOTES_E2E: "0",
  NOTES_E2E_STATE: statePath,
};
for (const args of [
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--env", environment, "--local", "--persist-to", statePath],
  ["build"],
]) {
  const result = spawnSync(pnpm, args, { cwd: root, env: buildEnv, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    restoreVars();
    process.exit(result.status ?? 1);
  }
}

const { CLOUDFLARE_ENV: _environment, ...previewEnv } = buildEnv;
const server = spawn(pnpm, ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: root,
  env: previewEnv,
  stdio: "inherit",
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    server.kill(signal);
  });
}
server.on("exit", (code) => {
  restoreVars();
  process.exitCode = stopping ? 0 : (code ?? 1);
});
