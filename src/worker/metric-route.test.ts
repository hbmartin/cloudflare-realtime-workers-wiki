import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondingMetricRoute } from "./metric-route";

describe("metric route selection", () => {
  it("does not select a matching handler registered after the route that responded", async () => {
    const app = new Hono();
    let metricRoute = "/unmatched";
    app.use("*", async (c, next) => {
      await next();
      metricRoute = respondingMetricRoute(c) ?? metricRoute;
    });
    app.all("/api/auth/*", (c) => {
      metricRoute = "/api/auth/*";
      return c.text("wildcard");
    });
    app.get("/api/auth/session", (c) => c.text("concrete"));

    const response = await app.request("http://example.test/api/auth/session");

    expect(await response.text()).toBe("wildcard");
    expect(metricRoute).toBe("/api/auth/*");
  });

  it("returns the concrete route that responded", async () => {
    const app = new Hono();
    let metricRoute = "/unmatched";
    app.use("*", async (c, next) => {
      await next();
      metricRoute = respondingMetricRoute(c) ?? metricRoute;
    });
    app.get("/pages/:id", (c) => c.text("page"));

    await app.request("http://example.test/pages/123");

    expect(metricRoute).toBe("/pages/:id");
  });

  it("attributes a response returned by middleware to its later concrete endpoint", async () => {
    const app = new Hono();
    let metricRoute = "/unmatched";
    app.use("*", async (c, next) => {
      await next();
      metricRoute = respondingMetricRoute(c) ?? metricRoute;
    });
    app.use("/v1/*", async (c, next) => {
      if (!c.req.header("authorization")) return c.text("unauthorized", 401);
      return await next();
    });
    app.get("/v1/pages/:id", (c) => c.text("page"));

    const response = await app.request("http://example.test/v1/pages/123");

    expect(response.status).toBe(401);
    expect(metricRoute).toBe("/v1/pages/:id");
  });
});
