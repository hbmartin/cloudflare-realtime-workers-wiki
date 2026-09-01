import "@mantine/core/styles.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { browserSupportsRequiredFeatures } from "./browser-support";
import "./styles.css";

const content = browserSupportsRequiredFeatures() ? (
  <MantineProvider defaultColorScheme="light">
    <App />
  </MantineProvider>
) : (
  <main className="splash" role="alert">
    <h1>Browser update required</h1>
    <p>Use Chrome or Edge 116+, Firefox 124+, or Safari 17.4+ to open this workspace.</p>
  </main>
);

createRoot(document.getElementById("root")!).render(<StrictMode>{content}</StrictMode>);
