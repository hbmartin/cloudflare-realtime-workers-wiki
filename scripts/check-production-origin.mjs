import { unstable_readConfig } from "wrangler";

export function configuredProductionOrigin({ configPath = "wrangler.jsonc", readConfig = unstable_readConfig } = {}) {
  const config = readConfig({ config: configPath, env: "production" }, { hideWarnings: true });
  const configured = config.vars?.BETTER_AUTH_URL;
  let parsed;
  try {
    parsed = typeof configured === "string" ? new URL(configured) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.origin !== configured) {
    throw new Error("Production BETTER_AUTH_URL must be configured as an exact origin.");
  }
  return configured;
}

export function checkProductionOrigin({ productionBaseURL = process.env.PRODUCTION_BASE_URL, ...config } = {}) {
  if (!productionBaseURL) throw new Error("PRODUCTION_BASE_URL must be set before deployment.");
  const configured = configuredProductionOrigin(config);
  if (productionBaseURL !== configured) {
    throw new Error("PRODUCTION_BASE_URL must exactly match production BETTER_AUTH_URL.");
  }
  return configured;
}

if (typeof import.meta.main !== "boolean") {
  throw new Error("This script requires a Node.js runtime with import.meta.main support.");
}

if (import.meta.main) {
  try {
    console.log(`Production health origin validated: ${checkProductionOrigin()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
