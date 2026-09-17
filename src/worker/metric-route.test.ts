import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerMetricMiddleware, respondingMetricRoute } from "./metric-route";

function createMetricApp() {
  const app = new Hono();
  let metricRoute = "/unmatched";
  registerMetricMiddleware(app, "*", async (c, next) => {
    await next();
    metricRoute = respondingMetricRoute(c) ?? metricRoute;
  });
  return { app, metricRoute: () => metricRoute };
}

describe("metric route selection", () => {
  it("does not select a matching handler registered after the route that responded", async () => {
    const { app, metricRoute } = createMetricApp();
    app.all("/api/auth/*", (c) => c.text("wildcard"));
    app.get("/api/auth/session", (c) => c.text("concrete"));

    const response = await app.request("http://example.test/api/auth/session");

    expect(await response.text()).toBe("wildcard");
    expect(metricRoute()).toBe("/api/auth/*");
  });

  it("returns the concrete route that responded", async () => {
    const { app, metricRoute } = createMetricApp();
    app.get("/pages/:id", (c) => c.text("page"));

    await app.request("http://example.test/pages/123");

    expect(metricRoute()).toBe("/pages/:id");
  });

  it("attributes a response returned by middleware to the first later matching endpoint", async () => {
    const { app, metricRoute } = createMetricApp();
    registerMetricMiddleware(app, "/v1/*", async (c, next) => {
      if (!c.req.header("authorization")) return c.text("unauthorized", 401);
      return await next();
    });
    app.get("/v1/users/me", (c) => c.text("me"));
    app.get("/v1/users/:userId", (c) => c.text("user"));

    const response = await app.request("http://example.test/v1/users/me");

    expect(response.status).toBe(401);
    expect(metricRoute()).toBe("/v1/users/me");
  });

  it("does not mistake a two-argument wildcard endpoint for middleware", async () => {
    const { app, metricRoute } = createMetricApp();
    app.all("/files/*", (c, _next) => c.text("wildcard"));
    app.get("/files/:id", (c) => c.text("file"));

    await app.request("http://example.test/files/123");

    expect(metricRoute()).toBe("/files/*");
  });

  it("leaves unmatched requests unattributed", async () => {
    const { app, metricRoute } = createMetricApp();

    await app.request("http://example.test/not-registered");

    expect(metricRoute()).toBe("/unmatched");
  });
});
