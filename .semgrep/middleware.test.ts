declare const app: any;
declare const notionApi: any;
declare const other: any;
declare const middleware: any;
declare const handler: any;
declare const method: any;
declare const Hono: any;
declare function registerMetricMiddleware(target: any, path: string, middleware: any): void;

function install(target: any) {
  target.use("*", middleware);
}

// ruleid: worker-hono-direct-middleware-registration
app.use("*", middleware);
// ruleid: worker-hono-direct-middleware-registration
notionApi.on("GET", "*", middleware);
// ruleid: worker-hono-direct-middleware-registration
app.all("/api/*", handler);

// ruleid: worker-hono-multiple-handlers
app.get("/api/pages", middleware, handler);
// ruleid: worker-hono-multiple-handlers
notionApi.post("/v1/pages", middleware, handler);

// ruleid: worker-hono-computed-registration
app[method]("/api/pages", handler);
// ruleid: worker-hono-computed-registration
notionApi[method]("/v1/pages", handler);

// ruleid: worker-hono-registration-alias
const register = app.use;
void register;
// ruleid: worker-hono-registration-destructure
const { get } = notionApi;
void get;
// ruleid: worker-hono-app-alias
const appAlias = app;
void appAlias;

// ruleid: worker-hono-app-escape
install(app);

// ruleid: worker-hono-construction
const constructed = new Hono();
void constructed;

// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
app.get("/api/pages", handler);
// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
notionApi.post("/v1/pages", handler);
// ok: worker-hono-direct-middleware-registration
other.use(middleware);
// ok: worker-hono-app-escape
registerMetricMiddleware(app, "*", middleware);
// ok: worker-hono-app-escape
app.route("/v1", notionApi);
// ruleid: worker-hono-import-alias
import { Hono as RenamedHono } from "hono";
void RenamedHono;
// ruleid: worker-hono-known-app-import-alias
import { notionApi as renamedNotionApi } from "./notion-api";
void renamedNotionApi;
