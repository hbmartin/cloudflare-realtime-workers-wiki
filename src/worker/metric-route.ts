import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { findTargetHandler } from "hono/utils/handler";

const metricMiddlewareHandlers = new WeakSet<object>();

function metricMiddleware<Handler extends object>(handler: Handler): Handler {
  metricMiddlewareHandlers.add(handler);
  return handler;
}

export function registerMetricMiddleware<E extends Env>(app: Hono<E>, path: string, handler: MiddlewareHandler<E>) {
  // eslint-disable-next-line no-restricted-properties -- This helper is the metric-aware registration boundary.
  app.use(path, metricMiddleware(handler));
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
