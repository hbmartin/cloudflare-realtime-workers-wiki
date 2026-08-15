import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const statePath = resolve(root, ".wrangler/e2e");
const cloudflareEnvironment = "notes-checks-e2e";
const devVarsPath = resolve(root, `.dev.vars.${cloudflareEnvironment}`);
const devVars = [
  "BETTER_AUTH_SECRET=e2e-secret-with-at-least-32-characters",
  "BETTER_AUTH_URL=http://127.0.0.1:4173",
  "BOOTSTRAP_TOKEN=e2e-bootstrap-token",
  "",
].join("\n");
if (!statePath.startsWith(`${root}/.wrangler/`)) throw new Error(`Refusing to clear unexpected path: ${statePath}`);
if (existsSync(devVarsPath) && readFileSync(devVarsPath, "utf8") !== devVars) {
  throw new Error(`Refusing to replace an existing ${devVarsPath}.`);
}
writeFileSync(devVarsPath, devVars, { encoding: "utf8", mode: 0o600 });
rmSync(statePath, { recursive: true, force: true });

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const migration = spawnSync(
  pnpm,
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--env",
    cloudflareEnvironment,
    "--local",
    "--persist-to",
    statePath,
  ],
  { cwd: root, encoding: "utf8", stdio: "inherit" },
);
if (migration.status !== 0) {
  rmSync(devVarsPath, { force: true });
  process.exit(migration.status ?? 1);
}

const server = spawn(pnpm, ["exec", "vite", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: root,
  env: {
    ...process.env,
    NOTES_E2E: "1",
    CLOUDFLARE_ENV: cloudflareEnvironment,
  },
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
  rmSync(devVarsPath, { force: true });
  process.exitCode = stopping ? 0 : (code ?? 1);
});
