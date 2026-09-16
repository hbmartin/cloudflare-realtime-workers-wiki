import type { Context } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import { findTargetHandler, isMiddleware } from "hono/utils/handler";

function isConcreteMetricRoute(route: string | undefined): route is string {
  return route !== undefined && route !== "/*" && !route.endsWith("/*");
}

export function respondingMetricRoute(c: Context) {
  const routes = matchedRoutes(c);
  const routeIndex = c.req.routeIndex;
  const responding = routePath(c);
  if (isConcreteMetricRoute(responding)) return responding;
  const concreteHandler = (route: (typeof routes)[number]) =>
    !isMiddleware(findTargetHandler(route.handler)) && isConcreteMetricRoute(route.path);
  const registered = routes.slice(0, routeIndex + 1).findLast(concreteHandler)?.path;
  if (registered) return registered;

  const current = routes[routeIndex];
  if (current && !isMiddleware(findTargetHandler(current.handler))) return undefined;
  // A middleware can reject a request before Hono reaches its concrete handler.
  // Look ahead only in that case so early endpoint errors retain their template.
  return routes.slice(routeIndex + 1).findLast(concreteHandler)?.path;
}
