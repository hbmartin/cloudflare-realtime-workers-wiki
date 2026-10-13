import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unstable_readConfig } from "wrangler";
import { emptyDatabaseSchema, emptyMigrationHistory, main as migrate, queryRows } from "./migrate-d1.mjs";

const require = createRequire(import.meta.url);
const manifestPath = ".wrangler/noteflare-build.json";
const secretKeys = ["BETTER_AUTH_SECRET", "WEBHOOK_ENCRYPTION_KEY", "OBSERVABILITY_PROBE_TOKEN", "BOOTSTRAP_TOKEN"];
const placeholderID = "00000000-0000-0000-0000-000000000000";
const databaseID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
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
  const api = async (path, { method = "GET", body, allowMissing = false, paginated = false, jurisdiction } = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...(jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
      },
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
    if (!response.ok || value?.success !== true)
      throw new Error(`Cloudflare ${method} request failed (${response.status}). Check account permissions.`);
    return paginated ? { result: value.result, result_info: value.result_info } : value.result;
  };
  return { account, api };
}

function deployedDatabaseID(settings) {
  const binding = settings?.bindings?.find((entry) => entry.name === "DB" && entry.type === "d1");
  if (!binding) return undefined;
  const id = binding.database_id ?? binding.id;
  if (typeof id !== "string" || !databaseID.test(id) || id === placeholderID)
    throw new Error("Existing DB binding has an invalid database ID. Refusing to select another database.");
  return id;
}

export function selectTarget({ forced, environment, workersCI, name, production, settings }) {
  if (forced === "production") return "production";
  if (forced === "portable") return "";
  if (environment !== undefined) return environment;
  if (!workersCI) return "production";
  return name === production.name && deployedDatabaseID(settings) === production.d1_databases?.[0]?.database_id
    ? "production"
    : "";
}

function installationResourceName(name, suffix, limit = 64) {
  const full = `${name}${suffix}`;
  if (full.length <= limit) return full;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, limit - suffix.length - hash.length - 1)}-${hash}${suffix}`;
}

export async function portableDatabase(config, settings, name, api, dryRun = false) {
  const declared = config.d1_databases[0];
  const savedID = deployedDatabaseID(settings);
  let id = declared.database_id === placeholderID ? undefined : declared.database_id;
  if (id !== undefined && (typeof id !== "string" || !databaseID.test(id)))
    throw new Error("Configured DB has an invalid database ID.");
  if (savedID && id && id !== savedID)
    throw new Error("DB differs from the existing deployment. Refusing to deploy to another database.");
  const sourceDatabaseID = id;
  id ??= savedID;
  const databaseName =
    declared.database_name === "noteflare" && !sourceDatabaseID
      ? installationResourceName(name, "-db")
      : declared.database_name;
  if (!id && !dryRun) {
    const matches = [];
    for (let page = 1; ; page++) {
      const resources = await api(`/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100&page=${page}`);
      if (!Array.isArray(resources) || resources.some((entry) => typeof entry?.name !== "string"))
        throw new Error("Cloudflare returned ambiguous D1 resources.");
      matches.push(...resources.filter((entry) => entry.name === databaseName));
      if (matches.length > 1) throw new Error("Cloudflare returned ambiguous D1 resources.");
      if (resources.length < 100) break;
    }
    if (matches.length) {
      id = matches[0].uuid;
      if (typeof id !== "string" || !databaseID.test(id) || id === placeholderID)
        throw new Error("D1 provisioning did not return a valid database ID.");
      // A build/deploy retry may reuse an empty provisioned resource. Populated databases
      // require a saved Worker binding or an explicit database_id before any migration.
      const query = async (sql) => {
        const result = await api(`/d1/database/${id}/query`, { method: "POST", body: { sql } });
        if (
          !Array.isArray(result) ||
          result.length !== 1 ||
          result[0]?.success !== true ||
          !Array.isArray(result[0].results)
        )
          throw new Error("Cloudflare returned invalid D1 query results.");
        return result[0].results;
      };
      const tables = await query("SELECT name FROM sqlite_master WHERE type='table';");
      if (
        !emptyDatabaseSchema(tables) ||
        (tables.some((row) => row.name === "d1_migrations") &&
          !emptyMigrationHistory(await query("SELECT count(*) applied FROM d1_migrations;")))
      )
        throw new Error(
          "Existing D1 database requires an explicit database_id or saved Worker DB binding before reuse.",
        );
    } else id = (await api("/d1/database", { method: "POST", body: { name: databaseName } }))?.uuid;
  }
  if (id !== undefined && (typeof id !== "string" || !databaseID.test(id) || id === placeholderID))
    throw new Error("D1 provisioning did not return a valid database ID.");
  if (!id && !dryRun) throw new Error("D1 provisioning did not return a valid database ID.");
  return { database_id: id ?? placeholderID, database_name: databaseName };
}

export function installationOrigin(configured, saved, name, subdomain) {
  if ((!configured || configured === "auto") && (!saved || saved === "auto")) {
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (typeof name !== "string" || !label.test(name) || typeof subdomain !== "string" || !label.test(subdomain))
      throw new Error("Activate a valid workers.dev subdomain in Cloudflare before deploying.");
  }
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

const templateSuffixes = new Map([
  ["bucket:noteflare", "-attachments"],
  ["queue:noteflare-delivery", "-delivery"],
  ["queue:noteflare-delivery-dlq", "-delivery-dlq"],
]);

export function validateDeliveryQueues(config) {
  const producers = config.queues?.producers ?? [];
  const delivery = producers.filter((producer) => producer.binding === "DELIVERY_QUEUE");
  if (delivery.length !== 1 || typeof delivery[0].queue !== "string" || !delivery[0].queue)
    throw new Error("Restore exactly one DELIVERY_QUEUE producer before deployment.");
  if (new Set(producers.map((producer) => producer.binding)).size !== producers.length)
    throw new Error("Queue producer bindings must be unique before deployment.");
  if (new Set(producers.map((producer) => producer.queue)).size !== producers.length)
    throw new Error("Queue producer mappings must be unique before deployment.");
  const consumers = config.queues?.consumers ?? [];
  if (consumers.length !== 1 || consumers[0].queue !== delivery[0].queue)
    throw new Error("The delivery consumer must target the DELIVERY_QUEUE producer's queue before deployment.");
}

export function portableResources(config, settings, name) {
  validateDeliveryQueues(config);
  // Only the source ID expresses operator intent. A discovered/created ID does not.
  const sourceID = config.d1_databases[0].database_id;
  const provisioned = typeof sourceID === "string" && databaseID.test(sourceID) && sourceID !== placeholderID;
  const resolveResource = (type, binding, configured, jurisdiction) => {
    const matches = (settings?.bindings ?? []).filter(
      (entry) => entry.name === binding && entry.type === (type === "bucket" ? "r2_bucket" : "queue"),
    );
    if (matches.length > 1) throw new Error(`Ambiguous saved ${binding} binding.`);
    const saved = matches[0]?.[type === "bucket" ? "bucket_name" : "queue_name"];
    if (matches.length && (typeof saved !== "string" || !saved)) throw new Error(`Invalid saved ${binding} name.`);
    const suffix = templateSuffixes.get(`${type}:${configured}`);
    const explicit = provisioned || !suffix;
    if (saved && !suffix && saved !== configured)
      throw new Error(
        `${binding} differs from the existing deployment. Update the portable configuration explicitly before retrying.`,
      );
    return {
      type,
      binding,
      name: saved ?? (explicit ? configured : installationResourceName(name, suffix, 63)),
      provenance: saved ? "saved" : explicit ? "configured" : "generated",
      ...(jurisdiction ? { jurisdiction } : {}),
    };
  };
  const resources = [
    ...config.r2_buckets.map((entry) =>
      resolveResource("bucket", entry.binding, entry.bucket_name, entry.jurisdiction),
    ),
    ...config.queues.producers.map((entry) => resolveResource("queue", entry.binding, entry.queue)),
  ];
  for (const [index, consumer] of config.queues.consumers.entries()) {
    for (const [role, template, binding, label] of [
      ["queue", "noteflare-delivery", "DELIVERY_QUEUE", "consumer"],
      ["dead_letter_queue", "noteflare-delivery-dlq", "DELIVERY_DEAD_LETTER_QUEUE", "dead-letter"],
    ]) {
      const queue = consumer[role];
      if (!queue || config.queues.producers.some((producer) => producer.queue === queue)) continue;
      if (queue === template) {
        if (config.queues.producers.some((producer) => producer.binding === binding)) continue;
        throw new Error(
          `The template ${label} queue requires a producer binding. Restore ${binding} or configure a custom, existing ${label} queue before retrying.`,
        );
      }
      resources.push({
        type: "queue",
        binding: `${role}:${index}`,
        name: queue,
        provenance: "configured",
        consumerOnly: true,
        role,
      });
    }
  }
  return resources;
}

export async function preflightGeneratedResources(resources, api) {
  for (const resource of resources.filter((entry) => entry.provenance === "generated" || entry.consumerOnly)) {
    let exists = false;
    if (resource.type === "bucket") {
      const bucket = await api(`/r2/buckets/${encodeURIComponent(resource.name)}`, {
        allowMissing: true,
        jurisdiction: resource.jurisdiction,
      });
      if (bucket !== null && bucket?.name !== resource.name)
        throw new Error("Cloudflare returned ambiguous R2 resources.");
      exists = bucket !== null;
    } else {
      let totalPages;
      const seen = new Set();
      for (let page = 1; ; page++) {
        const response = await api(`/queues?name=${encodeURIComponent(resource.name)}&per_page=100&page=${page}`, {
          paginated: true,
        });
        const entries = response?.result,
          info = response?.result_info;
        if (
          !Array.isArray(entries) ||
          entries.some(
            (entry) =>
              typeof entry?.queue_name !== "string" ||
              !entry.queue_name ||
              typeof entry?.queue_id !== "string" ||
              !entry.queue_id,
          ) ||
          !info ||
          info.page !== page ||
          !Number.isSafeInteger(info.total_pages) ||
          info.total_pages < 0 ||
          info.total_pages > 10_000 ||
          (info.count !== undefined && (!Number.isSafeInteger(info.count) || info.count !== entries.length)) ||
          (info.per_page !== undefined &&
            (!Number.isSafeInteger(info.per_page) || info.per_page < 1 || entries.length > info.per_page)) ||
          (info.total_count !== undefined &&
            (!Number.isSafeInteger(info.total_count) || info.total_count < entries.length)) ||
          (page > 1 && totalPages !== info.total_pages) ||
          (info.total_pages === 0 && entries.length !== 0) ||
          (info.total_pages > 0 && page > info.total_pages)
        )
          throw new Error("Cloudflare returned ambiguous queue resources or pagination.");
        totalPages = info.total_pages;
        for (const entry of entries) {
          if (seen.has(entry.queue_id)) throw new Error("Cloudflare returned ambiguous queue resources.");
          seen.add(entry.queue_id);
          if (entry.queue_name === resource.name) {
            if (exists) throw new Error("Cloudflare returned ambiguous queue resources.");
            exists = true;
          }
        }
        if (page >= totalPages) break;
      }
    }
    if (resource.consumerOnly) {
      if (!exists)
        throw new Error(
          `Configured ${resource.role === "queue" ? "consumer" : "dead-letter"} queue ${resource.name} does not exist. Create it or restore its producer binding before retrying.`,
        );
    } else if (exists)
      throw new Error(
        `Generated ${resource.type} ${resource.name} already exists. If a first deployment partially provisioned it, inspect and configure its name and the D1 ID explicitly to adopt those resources before retrying.`,
      );
  }
}

export async function createGeneratedResources(resources, api) {
  for (const resource of resources.filter((entry) => entry.provenance === "generated")) {
    // POST is create-only: a race must fail, never silently adopt another installation.
    const result = await api(resource.type === "bucket" ? "/r2/buckets" : "/queues", {
      method: "POST",
      body: resource.type === "bucket" ? { name: resource.name } : { queue_name: resource.name },
      jurisdiction: resource.jurisdiction,
    });
    if (
      (resource.type === "bucket" ? result?.name : result?.queue_name) !== resource.name ||
      (resource.type === "queue" && (typeof result?.queue_id !== "string" || !result.queue_id))
    )
      throw new Error(
        `Cloudflare returned invalid ${resource.type} creation results. Check provisioned resources before retrying.`,
      );
  }
}

export async function portablePreparation(config, settings, name, api, dryRun = false) {
  const resources = portableResources(config, settings, name);
  if (!dryRun) await preflightGeneratedResources(resources, api);
  const database = await portableDatabase(config, settings, name, api, dryRun);
  return { resources, database };
}

export function portableOverrides(
  config,
  settings,
  name,
  origin,
  database,
  resources = portableResources(config, settings, name),
) {
  const saved = Object.fromEntries(
    (settings?.bindings ?? [])
      .filter((binding) => binding.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  if (Object.keys({ ...config.vars, ...saved }).some((key) => privateVariable.test(key)))
    throw new Error("Move private credentials from plaintext variables to Worker secrets before deploying.");
  const resourceName = (type, binding) =>
    resources.find((entry) => entry.type === type && entry.binding === binding).name;
  const producers = config.queues.producers.map((producer) => ({
    ...producer,
    queue: resourceName("queue", producer.binding),
  }));
  const queueNames = new Map(
    config.queues.producers.map((producer, index) => [producer.queue, producers[index].queue]),
  );
  const consumerQueue = (queue, template, binding) =>
    queueNames.get(queue) ??
    (queue === template ? producers.find((entry) => entry.binding === binding)?.queue : undefined) ??
    queue;
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
    r2_buckets: config.r2_buckets.map((entry) => ({ ...entry, bucket_name: resourceName("bucket", entry.binding) })),
    ratelimits: config.ratelimits.map((entry) => {
      const binding = settings?.bindings?.find(
        (existing) => existing.type === "ratelimit" && existing.name === entry.name,
      );
      const namespace = binding
        ? binding.namespace_id
        : String(
            1_000_000 +
              Number.parseInt(createHash("sha256").update(`${name}:${entry.name}`).digest("hex").slice(0, 13), 16),
          );
      if (typeof namespace !== "string" || !/^[1-9][0-9]*$/.test(namespace))
        throw new Error("Existing rate-limit binding has an invalid namespace ID.");
      return { ...entry, namespace_id: namespace };
    }),
    queues: {
      producers,
      consumers: config.queues.consumers.map((consumer) => ({
        ...consumer,
        queue: consumerQueue(consumer.queue, "noteflare-delivery", "DELIVERY_QUEUE"),
        ...(consumer.dead_letter_queue
          ? {
              dead_letter_queue: consumerQueue(
                consumer.dead_letter_queue,
                "noteflare-delivery-dlq",
                "DELIVERY_DEAD_LETTER_QUEUE",
              ),
            }
          : {}),
      })),
    },
    // Reuse provisioned Workflows/datasets; only template defaults follow a renamed Worker.
    workflows: config.workflows.map((workflow) => ({
      ...workflow,
      name:
        settings?.bindings?.find((entry) => entry.type === "workflow" && entry.name === workflow.binding)
          ?.workflow_name ??
        (workflow.name === "noteflare-jobs" ? installationResourceName(name, "-jobs") : workflow.name),
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
    validateDeliveryQueues(config);
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
  const { database, resources } = await portablePreparation(root, settings, name, connection.api, dryRun);
  const savedURL = settings?.bindings?.find(
    (binding) => binding.name === "BETTER_AUTH_URL" && binding.type === "plain_text" && binding.text !== "auto",
  )?.text;
  const subdomain =
    (!root.vars.BETTER_AUTH_URL || root.vars.BETTER_AUTH_URL === "auto") && !savedURL
      ? (await connection.api("/workers/subdomain"))?.subdomain
      : undefined;
  const origin = installationOrigin(root.vars.BETTER_AUTH_URL, savedURL, name, subdomain);
  return {
    target,
    name,
    origin,
    account: connection.account,
    resources,
    overrides: portableOverrides(root, settings, name, origin, database, resources),
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
  if (manifest.overrides?.queues) validateDeliveryQueues(manifest.overrides);
  for (const key of ["source", "buildUUID", "revision", "target", "name", "account", "origin"])
    if (manifest[key] !== expected[key])
      throw new Error(`Build artifact does not match ${key}. Run the build again before deployment.`);
  if (
    manifest.configurationHash !== configurationHash(expected) ||
    manifest.configurationHash !== configurationHash(manifest)
  )
    throw new Error("Build artifact does not match configuration overrides. Run the build again before deployment.");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function configurationHash(context) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          version: 2,
          origin: context.origin,
          overrides: context.overrides ?? null,
          resources: context.resources ?? null,
        }),
      ),
    )
    .digest("hex");
}

async function build(context) {
  rmSync(manifestPath, { force: true });
  const workersCI = process.env.WORKERS_CI === "1";
  const source = workersCI ? fingerprint() : null;
  const environment = { ...process.env, CLOUDFLARE_ENV: context.target };
  if (context.overrides) environment.NOTES_DEPLOY_OVERRIDES = JSON.stringify(context.overrides);
  else delete environment.NOTES_DEPLOY_OVERRIDES;
  command(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build:app"], {
    env: environment,
    stdio: "inherit",
    timeout: undefined,
    shell: process.platform === "win32",
  });
  const configPath = outputConfig();
  const generated = unstable_readConfig({ config: configPath, env: "" }, { hideWarnings: true });
  validateDeliveryQueues(generated);
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
    configurationHash: configurationHash(context),
  };
  if (workersCI) {
    if (fingerprint() !== source) throw new Error("Source changed during the build. Rebuild before deployment.");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
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
    if (!emptyDatabaseSchema(tables))
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
  { migrateDatabase, provisionResources, upload, inspectSecrets, isInitialized, health, random = randomBytes },
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
  const generated = manifest.resources?.some((entry) => entry.provenance === "generated");
  try {
    if (generated) {
      if (!provisionResources) throw new Error("Resource provisioning is unavailable. Rebuild before deployment.");
      await provisionResources();
    }
    await withSecretsFile(secrets, upload);
  } catch (cause) {
    if (!generated) throw cause;
    throw new Error(
      "Resource provisioning or Worker upload failed. Before retrying a first deployment, inspect any created resources and explicitly configure their names and the populated D1 database ID to adopt them. After a successful upload, retries reuse saved Worker bindings.",
      { cause },
    );
  }
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
  validateDeliveryQueues(unstable_readConfig({ config: manifest.configPath, env: "" }, { hideWarnings: true }));
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
    provisionResources: async () => {
      const connection = await cloudflare();
      if (connection.account !== manifest.account)
        throw new Error("Cloudflare account changed. Rebuild before deployment.");
      await createGeneratedResources(manifest.resources, connection.api);
    },
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

export function deploymentErrorMessage(error) {
  const messages = [];
  const seen = new Set();
  for (let current = error; current !== undefined && messages.length < 8 && !seen.has(current);) {
    seen.add(current);
    if (typeof current === "object" && current !== null) {
      // Select diagnostic fields only; never serialize API responses or arbitrary objects.
      const { message, code, cause } = current;
      if (typeof message === "string" || (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)))
        messages.push(
          `${typeof message === "string" ? message : "Request failed."}${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}`,
        );
      else break;
      current = cause;
    } else {
      if (["string", "number", "boolean", "bigint"].includes(typeof current)) messages.push(String(current));
      break;
    }
  }
  return (messages.join("\nCaused by: ") || "Deployment failed.")
    .replace(/(https?:\/\/)[^\s/]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:xox[baprs]-|xoxe[.-]|ghp_|github_pat_|sk_|secret_)[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/\b((?:[a-z_]*(?:secret|token|password|api_key))\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 4_000);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(deploymentErrorMessage(error));
    process.exitCode = 1;
  }
}
