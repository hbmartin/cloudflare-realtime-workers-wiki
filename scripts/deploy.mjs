import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unstable_readConfig } from "wrangler";
import { internalTables, main as migrate, queryRows } from "./migrate-d1.mjs";

const require = createRequire(import.meta.url);
const manifestPath = ".wrangler/noteflare-build.json";
const secretKeys = ["BETTER_AUTH_SECRET", "WEBHOOK_ENCRYPTION_KEY", "OBSERVABILITY_PROBE_TOKEN", "BOOTSTRAP_TOKEN"];
const placeholderID = "00000000-0000-0000-0000-000000000000";
const privateVariable = /(?:SECRET|TOKEN|PASSWORD|ENCRYPTION_KEY|API_KEY)$/;

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 300_000, ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${program} ${args[0]} failed. See the preceding command output.`);
  return result.stdout;
}

function wrangler(args, options = {}) {
  return spawnSync(process.execPath, [require.resolve("wrangler"), ...args], {
    encoding: "utf8",
    timeout: 300_000,
    ...options,
  });
}

function wranglerJSON(args) {
  const result = wrangler(args);
  if (result.error || result.status !== 0)
    throw new Error(`Wrangler ${args[0]} failed. Check authentication and permissions.`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler ${args[0]} returned invalid JSON.`);
  }
}

async function cloudflare() {
  const credentials = wranglerJSON(["auth", "token", "--json"]);
  const headers =
    credentials.type === "api_key"
      ? { "X-Auth-Key": credentials.key, "X-Auth-Email": credentials.email }
      : { Authorization: `Bearer ${credentials.token}` };
  if (!credentials.token && !(credentials.key && credentials.email))
    throw new Error("Cloudflare authentication is missing.");
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const identity = wranglerJSON(["whoami", "--json"]);
    if (identity.accounts?.length !== 1)
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID when more than one account is available.");
    account = identity.accounts[0].id;
  }
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID.");
  const api = async (path, { method = "GET", body, allowMissing = false } = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    // API responses may contain credentials; report status codes, never bodies.
    if (allowMissing && response.status === 404) return null;
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error(`Cloudflare ${method} request returned invalid JSON.`);
    }
    if (!response.ok || value.success !== true)
      throw new Error(`Cloudflare ${method} request failed (${response.status}). Check account permissions.`);
    return value.result;
  };
  return { account, api };
}

export function selectTarget({ forced, environment, workersCI, name, production, settings }) {
  if (forced === "production") return "production";
  if (forced === "portable") return "";
  if (environment !== undefined) return environment;
  if (!workersCI) return "production";
  const deployedDB = settings?.bindings?.find((binding) => binding.name === "DB" && binding.type === "d1");
  return name === production.name && deployedDB?.id === production.d1_databases?.[0]?.database_id ? "production" : "";
}

export function installationOrigin(configured, saved, name, subdomain) {
  const origin =
    configured && configured !== "auto"
      ? configured
      : (saved !== "auto" && saved) || `https://${name}.${subdomain}.workers.dev`;
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("BETTER_AUTH_URL must be auto or an exact HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
    throw new Error("BETTER_AUTH_URL must be auto or an exact HTTPS origin.");
  return origin;
}

export function portableOverrides(config, settings, name, origin, database) {
  const saved = Object.fromEntries(
    (settings?.bindings ?? [])
      .filter((binding) => binding.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  if (Object.keys({ ...config.vars, ...saved }).some((key) => privateVariable.test(key)))
    throw new Error("Move private credentials from plaintext variables to Worker secrets before deploying.");
  const bucket = settings?.bindings?.find((binding) => binding.name === "BUCKET" && binding.type === "r2_bucket");
  if (
    bucket &&
    config.r2_buckets[0].bucket_name !== "noteflare" &&
    bucket.bucket_name !== config.r2_buckets[0].bucket_name
  )
    throw new Error(
      "BUCKET differs from the existing deployment. Update the portable configuration explicitly before retrying.",
    );
  return {
    name,
    vars: { ...config.vars, ...saved, BETTER_AUTH_URL: origin },
    d1_databases: [
      {
        ...config.d1_databases[0],
        ...database,
        migrations_dir: resolve(config.d1_databases[0].migrations_dir ?? "migrations"),
      },
    ],
    r2_buckets: config.r2_buckets.map((entry) => ({ ...entry, bucket_name: bucket?.bucket_name ?? entry.bucket_name })),
    queues: {
      producers: config.queues.producers.map((producer) => ({
        ...producer,
        queue:
          settings?.bindings?.find((entry) => entry.type === "queue" && entry.name === producer.binding)?.queue_name ??
          producer.queue,
      })),
      consumers: config.queues.consumers.map((consumer) => ({
        ...consumer,
        queue:
          settings?.bindings?.find((entry) => entry.type === "queue" && entry.name === "DELIVERY_QUEUE")?.queue_name ??
          config.queues.producers.find((entry) => entry.binding === "DELIVERY_QUEUE").queue,
        dead_letter_queue:
          settings?.bindings?.find((entry) => entry.type === "queue" && entry.name === "DELIVERY_DEAD_LETTER_QUEUE")
            ?.queue_name ??
          config.queues.producers.find((entry) => entry.binding === "DELIVERY_DEAD_LETTER_QUEUE").queue,
      })),
    },
    // Reuse provisioned Workflows/datasets; only template defaults follow a renamed Worker.
    workflows: config.workflows.map((workflow) => ({
      ...workflow,
      name:
        settings?.bindings?.find((entry) => entry.type === "workflow" && entry.name === workflow.binding)
          ?.workflow_name ?? (workflow.name === "noteflare-jobs" ? `${name}-jobs` : workflow.name),
    })),
    analytics_engine_datasets: config.analytics_engine_datasets.map((dataset) => ({
      ...dataset,
      dataset:
        settings?.bindings?.find((entry) => entry.type === "analytics_engine" && entry.name === dataset.binding)
          ?.dataset ?? (dataset.dataset === "noteflare" ? name.replaceAll("-", "_") : dataset.dataset),
    })),
  };
}

async function prepare(forced, dryRun) {
  const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
  const production = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
  const name = process.env.WRANGLER_CI_OVERRIDE_NAME || root.name;
  let connection, settings;
  if (
    forced === "portable" ||
    (!forced && process.env.CLOUDFLARE_ENV === undefined && process.env.WORKERS_CI === "1")
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Invalid portable Worker name.");
    connection = await cloudflare();
    settings = await connection.api(`/workers/scripts/${name}/settings`, { allowMissing: true });
    if (settings && !Array.isArray(settings.bindings)) throw new Error("Cloudflare returned invalid Worker bindings.");
  }
  const target = selectTarget({
    forced,
    environment: process.env.CLOUDFLARE_ENV,
    workersCI: process.env.WORKERS_CI === "1",
    name,
    production,
    settings,
  });
  if (target) {
    const config = unstable_readConfig({ config: "wrangler.jsonc", env: target }, { hideWarnings: true });
    return {
      target,
      name: process.env.WRANGLER_CI_OVERRIDE_NAME || config.name,
      origin: config.vars.BETTER_AUTH_URL,
      account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      ...(process.env.WRANGLER_CI_OVERRIDE_NAME ? { overrides: { name: process.env.WRANGLER_CI_OVERRIDE_NAME } } : {}),
    };
  }
  connection ??= await cloudflare();
  settings ??= await connection.api(`/workers/scripts/${name}/settings`, { allowMissing: true });
  const savedDB = settings?.bindings?.find((binding) => binding.name === "DB" && binding.type === "d1");
  const declaredDB = root.d1_databases[0];
  let id = declaredDB.database_id;
  if (savedDB && id && id !== placeholderID && id !== savedDB.id)
    throw new Error("DB differs from the existing deployment. Refusing to deploy to another database.");
  if (!id || id === placeholderID) id = savedDB?.id;
  if (!id && !dryRun) {
    const matches = await connection.api(`/d1/database?name=${encodeURIComponent(declaredDB.database_name)}`);
    if (
      !Array.isArray(matches) ||
      matches.length > 1 ||
      matches.some((entry) => entry.name !== declaredDB.database_name)
    )
      throw new Error("Cloudflare returned ambiguous D1 resources.");
    id = matches[0]?.uuid;
    if (!id)
      id = (await connection.api("/d1/database", { method: "POST", body: { name: declaredDB.database_name } })).uuid;
  }
  if ((id && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) || (!dryRun && (!id || id === placeholderID)))
    throw new Error("D1 provisioning did not return a valid database ID.");
  const savedURL = settings?.bindings?.find(
    (binding) => binding.name === "BETTER_AUTH_URL" && binding.type === "plain_text" && binding.text !== "auto",
  )?.text;
  const subdomain =
    root.vars.BETTER_AUTH_URL === "auto" && !savedURL
      ? (await connection.api("/workers/subdomain"))?.subdomain
      : undefined;
  if (root.vars.BETTER_AUTH_URL === "auto" && !savedURL && !subdomain)
    throw new Error("Activate a workers.dev subdomain in Cloudflare before deploying.");
  const origin = installationOrigin(root.vars.BETTER_AUTH_URL, savedURL, name, subdomain);
  return {
    target,
    name,
    origin,
    account: connection.account,
    overrides: portableOverrides(root, settings, name, origin, { database_id: id ?? placeholderID }),
  };
}

function fingerprint() {
  const hash = createHash("sha256").update(command("git", ["rev-parse", "HEAD"]));
  for (const file of command("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hash.update(file);
    if (existsSync(file)) hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

export function outputConfig(root = process.cwd()) {
  const pointer = resolve(root, ".wrangler/deploy/config.json");
  const path = resolve(dirname(pointer), JSON.parse(readFileSync(pointer, "utf8")).configPath);
  if (relative(resolve(root, "dist"), path).startsWith(".."))
    throw new Error("Vite did not produce a configuration inside dist.");
  return path;
}

export function verifyBuild(manifest, expected) {
  for (const key of ["source", "buildUUID", "revision", "target", "name", "account"])
    if (manifest[key] !== expected[key])
      throw new Error(`Build artifact does not match ${key}. Run the build again before deployment.`);
}

async function build(context) {
  rmSync(manifestPath, { force: true });
  const source = fingerprint();
  const environment = { ...process.env, CLOUDFLARE_ENV: context.target };
  if (context.overrides) environment.NOTES_DEPLOY_OVERRIDES = JSON.stringify(context.overrides);
  else delete environment.NOTES_DEPLOY_OVERRIDES;
  command(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build:app"], {
    env: environment,
    stdio: "inherit",
    timeout: undefined,
  });
  const configPath = outputConfig();
  const generated = unstable_readConfig({ config: configPath, env: "" }, { hideWarnings: true });
  if (generated.name !== context.name || generated.vars.BETTER_AUTH_URL !== context.origin)
    throw new Error("Vite output does not match the prepared deployment target.");
  if (Object.keys(generated.vars).some((key) => privateVariable.test(key)))
    throw new Error("Vite output contains a private credential in vars.");
  const manifest = {
    ...context,
    source,
    buildUUID: process.env.WORKERS_CI_BUILD_UUID ?? null,
    revision: process.env.WORKERS_CI_COMMIT_SHA ?? null,
    configPath,
    configHash: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
  };
  if (fingerprint() !== source) throw new Error("Source changed during the build. Rebuild before deployment.");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifest;
}

export function initializedDatabase(configPath, execute = wrangler) {
  const query = (sql) =>
    queryRows(
      execute(["d1", "execute", "DB", "--config", configPath, "--remote", "--json", "--command", sql]),
      "installation preflight",
    );
  const tables = query("SELECT name FROM sqlite_master WHERE type='table';");
  if (tables.some((row) => !row || typeof row.name !== "string")) throw new Error("Invalid installation schema.");
  if (!tables.some((row) => row.name === "install_state")) {
    if (tables.some((row) => !internalTables.has(row.name)))
      throw new Error("Database contains unknown application tables. Refusing to initialize it.");
    return false;
  }
  const rows = query("SELECT count(*) initialized FROM install_state WHERE id=1;");
  if (rows.length !== 1 || ![0, 1].includes(rows[0]?.initialized)) throw new Error("Invalid installation state.");
  return rows[0].initialized === 1;
}

export function missingSecrets(names, initialized) {
  if (initialized && !names.includes("BETTER_AUTH_SECRET"))
    throw new Error(
      "An initialized installation is missing BETTER_AUTH_SECRET. Restore the original secret; automatic replacement would invalidate sessions and internal calls.",
    );
  return initialized ? [] : secretKeys.filter((key) => key !== "BOOTSTRAP_TOKEN" && !names.includes(key));
}

export async function withSecretsFile(secrets, operation) {
  if (!Object.keys(secrets).length) return operation(undefined);
  const directory = mkdtempSync(resolve(tmpdir(), "noteflare-secrets-"));
  const path = resolve(directory, "secrets.json");
  try {
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    return await operation(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function deployPrepared(
  manifest,
  { migrateDatabase, upload, inspectSecrets, isInitialized, health, random = randomBytes },
) {
  const secrets = {};
  if (!manifest.target) {
    const initialized = await isInitialized();
    const names = await inspectSecrets();
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
      throw new Error("Invalid Worker secret listing.");
    if (!initialized && !names.includes("BOOTSTRAP_TOKEN")) {
      const token = process.env.BOOTSTRAP_TOKEN;
      if (!token || token.length < 32 || token.startsWith("replace-"))
        throw new Error(
          "Set a private setup key (BOOTSTRAP_TOKEN) with at least 32 characters before first deployment.",
        );
      secrets.BOOTSTRAP_TOKEN = token;
    }
    for (const key of missingSecrets(names, initialized)) secrets[key] = random(32).toString("base64url");
  }
  if ((await migrateDatabase()) !== 0)
    throw new Error("D1 migration preflight/application failed. Worker upload was not started.");
  await withSecretsFile(secrets, upload);
  await health();
}

async function checkHealth(origin) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) });
      const install = await fetch(`${origin}/api/install`, { signal: AbortSignal.timeout(15_000) });
      const status = await install.json();
      if (health.ok && install.ok && (await health.json()).ok === true && typeof status.initialized === "boolean") {
        console.log(
          `NoteFlare is available at ${origin}${status.initialized ? "" : ". Open it and use your setup key to create the owner and enroll MFA."}`,
        );
        return;
      }
    } catch {
      /* Retry transient startup/network failures without printing responses. */
    }
    if (attempt < 4) await delay(10_000);
  }
  throw new Error(
    "Deployment completed, but health verification failed. Check Worker logs before retrying; resources and migrations were preserved.",
  );
}

export async function main(argv) {
  const [action, ...options] = argv;
  if (
    !["build", "deploy"].includes(action) ||
    options.some((option) => !["--one-click", "--production", "--dry-run"].includes(option)) ||
    (options.includes("--one-click") && options.includes("--production"))
  )
    throw new Error("Usage: deploy.mjs build|deploy [--one-click|--production] [--dry-run]");
  const forced = options.includes("--one-click")
    ? "portable"
    : options.includes("--production")
      ? "production"
      : undefined;
  const dryRun = options.includes("--dry-run");
  const context = await prepare(forced, dryRun);
  let manifest;
  if (action === "deploy" && process.env.WORKERS_CI === "1" && existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyBuild(manifest, {
      ...context,
      source: fingerprint(),
      buildUUID: process.env.WORKERS_CI_BUILD_UUID ?? null,
      revision: process.env.WORKERS_CI_COMMIT_SHA ?? null,
    });
    if (
      manifest.configPath !== outputConfig() ||
      manifest.configHash !== createHash("sha256").update(readFileSync(manifest.configPath)).digest("hex")
    )
      throw new Error("Generated deployment configuration changed. Rebuild before deployment.");
  } else manifest = await build(context);
  if (action === "build") return;
  const configArgs = ["--config", manifest.configPath];
  if (dryRun) {
    const result = wrangler(["deploy", ...configArgs, "--dry-run"], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error("Worker dry run failed.");
    return;
  }
  await deployPrepared(manifest, {
    isInitialized: () => initializedDatabase(manifest.configPath),
    inspectSecrets: async () => {
      const connection = await cloudflare();
      const names = await connection.api(`/workers/scripts/${manifest.name}/secrets`, { allowMissing: true });
      if (names !== null && !Array.isArray(names)) throw new Error("Invalid Worker secret listing.");
      return (names ?? []).map((entry) => entry.name);
    },
    migrateDatabase: () =>
      migrate(["--remote", ...configArgs], wrangler, {
        slackReviewMigrationSafe: process.env.SLACK_REVIEW_MIGRATION_SAFE === "true",
        pageMoveMigrationSafe: process.env.PAGE_MOVE_RECEIPT_MIGRATION_SAFE === "true",
      }),
    upload: (path) => {
      const result = wrangler(["deploy", ...configArgs, ...(path ? ["--secrets-file", path] : [])], {
        stdio: "inherit",
        timeout: undefined,
      });
      if (result.error || result.status !== 0) throw new Error("Worker upload failed.");
    },
    health: () => checkHealth(manifest.origin),
  });
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment failed.");
    process.exitCode = 1;
  }
}
