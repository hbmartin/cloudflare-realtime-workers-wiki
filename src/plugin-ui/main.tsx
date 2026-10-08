import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { openResultSchema } from "../shared/plugin-contracts";
import { pluginApi } from "./api";
import { PluginApp } from "./PluginApp";
import "./style.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing NoteFlare UI root.");
const root = createRoot(container);
const app = new App({ name: "NoteFlare", version: "0.1.0" }, {});
const api = pluginApi(app);
let initialPageId: string | undefined;
let linkedPage: { title: string; url: string; kind: "diagram" | "table" } | null = null;
let linkError = "";
let connected = false;
function render() {
  if (connected)
    root.render(
      <>
        {linkedPage ? (
          <div className="message">
            {linkedPage.title} is a {linkedPage.kind}. Open it in NoteFlare to read or edit it.
            <button
              type="button"
              onClick={() => {
                if (linkedPage)
                  void api.link(linkedPage.url).catch(() => {
                    linkError = "The link could not be opened.";
                    render();
                  });
              }}
            >
              Open in NoteFlare ↗
            </button>
          </div>
        ) : null}
        {linkError ? <p role="alert">{linkError}</p> : null}
        <PluginApp api={api} initialPageId={initialPageId} />
      </>,
    );
}
app.ontoolresult = (result) => {
  const parsed = openResultSchema.safeParse(result.structuredContent);
  if (parsed.success) {
    initialPageId = parsed.data.initialPageId ?? undefined;
    linkedPage = parsed.data.linkedPage;
    linkError = "";
  }
  render();
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
};
root.render(<output>Connecting to NoteFlare…</output>);
void app
  .connect()
  .then(() => {
    connected = true;
    const theme = app.getHostContext()?.theme;
    if (theme) document.documentElement.dataset.theme = theme;
    render();
  })
  .catch(() => root.render(<p role="alert">Open NoteFlare from the ChatGPT plugin to connect to your workspace.</p>));
