declare const app: any;
declare const notionApi: any;
declare const other: any;
declare const middleware: any;
declare const handler: any;
declare const method: any;
declare const Hono: any;
declare const honoModule: any;
declare const appModule: any;
declare const holder: any;
declare const c: any;
declare const admin: any;
declare function register(value: any): void;
declare function leak(value: any): void;
declare function registerMetricMiddleware(target: any, path: string, middleware: any): void;

function install(target: any) {
  // ruleid: worker-hono-direct-middleware-registration
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

// ruleid: worker-hono-computed-registration, worker-hono-app-escape
app[method]("/api/pages", () => leak(app));
// ruleid: worker-hono-computed-registration, worker-hono-app-escape
notionApi[method]("/v1/pages", () => leak(notionApi));

app.get("/api/same-name-alias", () => {
  // ruleid: worker-hono-app-escape
  holder.fn = app.get;
});

// ruleid: worker-hono-computed-registration
app[method]("/api/computed-alias", () => {
  // ruleid: worker-hono-app-escape
  holder.fn = app[method];
});

registerMetricMiddleware(app, "*", () => {
  // ruleid: worker-hono-app-escape
  holder.ref = app;
  // ruleid: worker-hono-app-escape
  leak(app);
});

app.route("/v1", notionApi, () => {
  // ruleid: worker-hono-app-escape
  holder.ref = notionApi;
  // ruleid: worker-hono-app-escape
  leak(notionApi);
});

// ruleid: worker-hono-app-escape
holder.returned = app.get("/api/returned", handler);
// ruleid: worker-hono-app-escape
const v2 = app.basePath("/v2");
v2.get("/pages", middleware, handler);

function returnedApp() {
  // ruleid: worker-hono-app-escape
  return notionApi.post("/v1/returned", handler);
}
void returnedApp;

// ruleid: worker-hono-app-escape
register(app.get("/api/passed-return", handler));

// ruleid: worker-hono-computed-registration
other["use"]("*", middleware);

// ruleid: worker-hono-use-alias
const useAlias = app.use;
void useAlias;
// ruleid: worker-hono-app-escape
const onRegister = app.on;
void onRegister;
// ruleid: worker-hono-use-alias
const otherRegister = other.use;
void otherRegister;
// ruleid: worker-hono-use-alias
const boundRegister = other.use.bind(other);
void boundRegister;
// ruleid: worker-hono-use-alias
const computedRegister = other["use"];
void computedRegister;
// ruleid: worker-hono-use-alias
const { use: destructuredUse } = other;
void destructuredUse;
// ruleid: worker-hono-use-alias
(0, app.use)("*", middleware);
// ruleid: worker-hono-use-alias
const useObject = { register: notionApi.use };
void useObject;
// ruleid: worker-hono-use-alias
register(app.use);
// ruleid: worker-hono-app-escape
const { get } = notionApi;
void get;
// ruleid: worker-hono-app-escape
const appAlias = app;
void appAlias;

// ruleid: worker-hono-app-escape
install(app);

// ruleid: worker-hono-construction
const constructed = new Hono();
void constructed;
// ruleid: worker-hono-construction
const reflected = Reflect.construct(Hono, []);
void reflected;
// ruleid: worker-hono-constructor-alias
const HonoAlias = Hono;
void HonoAlias;
// ruleid: worker-hono-constructor-alias
const NamespaceHono = honoModule.Hono;
void NamespaceHono;
// ruleid: worker-hono-constructor-alias
const { Hono: DestructuredHono } = honoModule;
void DestructuredHono;
// ruleid: worker-hono-subclass
class HonoSubclass extends Hono {}
void HonoSubclass;
// ruleid: worker-hono-subclass
const anonymousSubclass = new (class extends Hono {})();
void anonymousSubclass;
// ruleid: worker-hono-constructor-alias
register(Hono);
// ruleid: worker-hono-constructor-alias
const constructorObject = { value: Hono };
void constructorObject;
// ruleid: worker-hono-constructor-alias
const constructorArray = [Hono];
void constructorArray;

// ruleid: worker-hono-app-escape
holder.ref = app;
// ruleid: worker-hono-app-escape
const appObject = { ref: app };
void appObject;
// ruleid: worker-hono-app-escape
const appArray = [app];
void appArray;
// ruleid: worker-hono-app-escape
export { notionApi as exportedAppAlias };
// ruleid: worker-hono-app-escape
export default app;

// ok: worker-hono-app-escape
const requestApp = c.req.app;
void requestApp;
// ok: worker-hono-app-escape
const adminApp = admin.app;
void adminApp;
// ok: worker-hono-app-escape
const unrelatedMember = appModule.notionApi;
void unrelatedMember;

// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
app.get("/api/pages", handler);
// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
notionApi.post("/v1/pages", handler);
// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
// ruleid: worker-hono-app-escape
app.get("/api/leak", () => leak(app));
// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
// ruleid: worker-hono-app-escape
notionApi.get("/v1/leak", () => leak(notionApi));
// ruleid: worker-hono-direct-middleware-registration
other.use(middleware);
// ok: worker-hono-direct-middleware-registration
other.on("event", handler);
// ok: worker-hono-direct-middleware-registration
other.all();
// ok: worker-hono-app-escape
registerMetricMiddleware(app, "*", middleware);
// ok: worker-hono-app-escape
app.route("/v1", notionApi);
// ruleid: worker-hono-import-alias
import { Hono as RenamedHono } from "hono";
// ruleid: worker-hono-constructor-alias
void RenamedHono;
// ruleid: worker-hono-known-app-import-alias
import { notionApi as renamedNotionApi } from "./notion-api";
void renamedNotionApi;
// ruleid: worker-hono-known-app-import-alias
import * as notionModule from "./notion-api";
void notionModule;
