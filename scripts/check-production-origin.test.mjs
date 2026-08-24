import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkProductionOrigin, configuredProductionOrigin } from "./check-production-origin.mjs";

const configWith = (betterAuthURL) => () => ({ vars: { BETTER_AUTH_URL: betterAuthURL } });
const entrypoint = fileURLToPath(new URL("./check-production-origin.mjs", import.meta.url));

describe("production origin validation", () => {
  it("executes Wrangler's production config reader against this repository", () => {
    const configured = configuredProductionOrigin();

    expect(checkProductionOrigin({ productionBaseURL: configured })).toBe(configured);
  });

  it("executes the same CLI entry point used by the deployment workflow", () => {
    const configured = configuredProductionOrigin();
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PRODUCTION_BASE_URL: configured },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Production health origin validated: ${configured}`);
  });

  it("requires the health-check origin", () => {
    expect(() =>
      checkProductionOrigin({ productionBaseURL: "", readConfig: configWith("https://notes.example.test") }),
    ).toThrow("PRODUCTION_BASE_URL must be set");
  });

  it.each(["https://notes.example.test/", "https://notes.example.test/path", "not a URL"])(
    "rejects a production BETTER_AUTH_URL that is not an exact origin: %s",
    (configured) => {
      expect(() =>
        checkProductionOrigin({ productionBaseURL: configured, readConfig: configWith(configured) }),
      ).toThrow("Production BETTER_AUTH_URL must be configured as an exact origin");
    },
  );

  it("requires both configured origins to match exactly", () => {
    expect(() =>
      checkProductionOrigin({
        productionBaseURL: "https://probe.example.test",
        readConfig: configWith("https://notes.example.test"),
      }),
    ).toThrow("PRODUCTION_BASE_URL must exactly match production BETTER_AUTH_URL");
  });
});
