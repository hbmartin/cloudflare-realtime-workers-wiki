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
declare function registerMetricMiddleware(target: any, path: string, middleware: any): void;
declare function consumeUse(target: any): void;
declare function inspect(target: any): void;

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

// ruleid: worker-hono-computed-registration
app[method]("/api/pages", handler);
// ruleid: worker-hono-computed-registration
notionApi[method]("/v1/pages", handler);

// ruleid: worker-hono-computed-registration
other["use"]("*", middleware);

// ruleid: worker-hono-use-alias
const register = app.use;
void register;
// ruleid: worker-hono-registration-alias
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
const methodHolder = { register: notionApi.use };
void methodHolder;
// ruleid: worker-hono-use-alias
consumeUse(app.use);
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
const AnonymousHonoSubclass = new (class extends Hono {})();
void AnonymousHonoSubclass;
// ruleid: worker-hono-constructor-escape
inspect(Hono);
// ruleid: worker-hono-constructor-escape
const constructorHolder = { constructor: Hono };
void constructorHolder;
// ruleid: worker-hono-constructor-array
const constructorArray = [Hono];
void constructorArray;
// ok: worker-hono-app-alias
const memberAppAlias = appModule.notionApi;
void memberAppAlias;
// ok: worker-hono-app-alias
const { notionApi: destructuredAppAlias } = appModule;
void destructuredAppAlias;
// ruleid: worker-hono-app-container
export { notionApi as exportedAppAlias };
let assignedApp: any;
// ruleid: worker-hono-app-assignment
assignedApp = app;
void assignedApp;
// ruleid: worker-hono-app-container
holder.ref = app;
// ruleid: worker-hono-app-container
const appHolder = { ref: app };
void appHolder;
// ruleid: worker-hono-app-container
const shorthandAppHolder = { app };
void shorthandAppHolder;
// ruleid: worker-hono-app-array
const appArray = [app];
void appArray;
// ruleid: worker-hono-app-container
export default app;

// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
app.get("/api/pages", handler);
// ok: worker-hono-direct-middleware-registration
// ok: worker-hono-multiple-handlers
notionApi.post("/v1/pages", handler);
// ruleid: worker-hono-direct-middleware-registration
other.use(middleware);
// ok: worker-hono-direct-middleware-registration
other.on("event", handler);
// ok: worker-hono-direct-middleware-registration
other.all();
// ok: worker-hono-app-alias
const requestApp = c.req.app;
void requestApp;
// ok: worker-hono-app-alias
const adminApp = admin.app;
void adminApp;
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
