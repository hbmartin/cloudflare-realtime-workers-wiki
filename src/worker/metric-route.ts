import type { Context } from "hono";
import { matchedRoutes } from "hono/route";
import { findTargetHandler } from "hono/utils/handler";

const metricMiddlewareHandlers = new WeakSet<object>();

export function metricMiddleware<Handler extends object>(handler: Handler): Handler {
  metricMiddlewareHandlers.add(handler);
  return handler;
}

function isMetricRoute(route: string | undefined): route is string {
  return route !== undefined && route !== "" && route !== "*" && route !== "/*";
}

function isMetricMiddleware(route: ReturnType<typeof matchedRoutes>[number]) {
  return metricMiddlewareHandlers.has(findTargetHandler(route.handler));
}

export function respondingMetricRoute(c: Context) {
  const routes = matchedRoutes(c);
  const routeIndex = c.req.routeIndex;
  const current = routes[routeIndex];
  if (!current) return undefined;
  if (!isMetricMiddleware(current)) return isMetricRoute(current.path) ? current.path : undefined;
  // A middleware can reject a request before Hono reaches its concrete handler.
  // Look ahead only in that case so early endpoint errors retain their template.
  return routes.slice(routeIndex + 1).find((route) => !isMetricMiddleware(route) && isMetricRoute(route.path))?.path;
}
