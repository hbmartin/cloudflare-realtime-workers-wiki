import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const localBaseURL = "http://127.0.0.1:4173";
const baseURL = process.env.NOTES_LOAD_BASE_URL ?? localBaseURL;
const connectionCount = Number.parseInt(process.env.NOTES_LOAD_CONNECTIONS ?? "30", 10);
const holdMilliseconds = Number.parseInt(process.env.NOTES_LOAD_HOLD_MS ?? "5000", 10);
const email = process.env.NOTES_LOAD_EMAIL ?? "owner@example.test";
const password = process.env.NOTES_LOAD_PASSWORD ?? "password123";
const token = process.env.NOTES_LOAD_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token";
let server;

if (!Number.isInteger(connectionCount) || connectionCount < 1 || connectionCount > 100) {
  throw new Error("NOTES_LOAD_CONNECTIONS must be an integer between 1 and 100.");
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseURL}/api/health`)).ok) return;
    } catch {
      // The local server is still starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${baseURL}.`);
}

function sessionCookie(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function post(path, body, cookie = "") {
  return fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function authenticate() {
  const install = await (await fetch(`${baseURL}/api/install`)).json();
  if (!install.initialized) {
    const response = await post("/api/install/bootstrap", {
      bootstrapToken: token,
      workspaceName: "Load Test Notes",
      name: "Load Test Owner",
      email,
      password,
    });
    if (!response.ok) throw new Error(`Bootstrap failed (${response.status}).`);
    return sessionCookie(response);
  }

  const response = await post("/api/auth/sign-in/email", { email, password, callbackURL: "/" });
  if (!response.ok) throw new Error(`Sign in failed (${response.status}).`);
  return sessionCookie(response);
}

try {
  if (!process.env.NOTES_LOAD_BASE_URL) {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    server = spawn(pnpm, ["dev:e2e"], { stdio: "inherit", env: process.env });
  }
  await waitForHealth();
  const cookie = await authenticate();
  if (!cookie) throw new Error("Authentication did not return a session cookie.");
  const treeResponse = await fetch(`${baseURL}/api/pages/tree`, { headers: { cookie, origin: baseURL } });
  if (!treeResponse.ok) throw new Error(`Page tree failed (${treeResponse.status}).`);
  const { pages } = await treeResponse.json();
  const page = pages.find((item) => item.kind === "document");
  if (!page) throw new Error("No document page is available for the load check.");

  const socketURL = new URL(`/parties/document/${page.id}~${page.contentEpoch}`, baseURL);
  socketURL.protocol = socketURL.protocol === "https:" ? "wss:" : "ws:";
  const sockets = Array.from(
    { length: connectionCount },
    () => new WebSocket(socketURL, { headers: { cookie, origin: baseURL } }),
  );
  await Promise.all(
    sockets.map(async (socket) => {
      await Promise.race([
        once(socket, "open"),
        delay(20_000).then(() => Promise.reject(new Error("A realtime connection timed out."))),
      ]);
    }),
  );
  console.log(`Opened ${sockets.length} authenticated realtime connections.`);
  await delay(holdMilliseconds);
  await Promise.all(
    sockets.map(async (socket) => {
      socket.close(1000, "load check complete");
      await Promise.race([
        once(socket, "close"),
        delay(5_000).then(() => Promise.reject(new Error("A realtime connection did not close."))),
      ]);
    }),
  );
} finally {
  server?.kill("SIGTERM");
}
